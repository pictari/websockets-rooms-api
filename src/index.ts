import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 } from 'uuid';
import { Gamedata, Status } from './models/internal/gamedata';
import { DeleteItemCommand, DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { WsCommand } from './models/internal/wscommand';

const pathServer: Map<string, WebSocketServer> = new Map();
const pathSettings: Map<string, Gamedata> = new Map();
const client : DynamoDBClient = new DynamoDBClient({});

// https://medium.com/@libinthomas33/building-a-crud-api-server-in-node-js-using-http-module-9fac57e2f47d
const server = createServer((req, res) =>
{
    let body = "";
    let resultingJson : any;
    try {
        req.on("data", (chunk) => {
            body += chunk;
        })
    
        req.on("end", () => {
            resultingJson = JSON.parse(body);
        })    
    } catch(error) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end("Error parsing your request body. This server only accepts JSON.\n\n" + error);
        return;
    }

    // make the server with initial gamedata
    if(req.method === 'POST') {
        let gamedata : Gamedata;
        try {
            gamedata = createGamedata(resultingJson);
        } catch(error) {
            res.writeHead(400, { "content-type": "text/html" });
            res.end("The request body contains malformed JSON.\n\n" + error);
            return;
        }
        let newPath = raiseNewWSServer(gamedata);
        updateDynamoTable(newPath);
        res.writeHead(201, { "content-type": "application/json" });
        res.end({"newServerPath": newPath});
    }
});

server.on('upgrade', function upgrade(request, socket, head) {
    // change base url when we get a domain
    let pathName = new URL(request.url as string, 'ws://pictari.app');
    let found : boolean = false;

    // cycle through all the active "sub"servers
    for(let key in pathServer.keys) {
        if(pathName.toString() === '/' + key) {
            if(pathSettings.get(key)?.status == Status.waiting) {
                found = true;
                let wss = pathServer.get(key);
                wss?.handleUpgrade(request, socket, head, function done(ws) {
                    wss.emit('connection', ws, request);
                })
                break;
            }
        }
    }

    if(!found) {
        socket.destroy();
    }
});

server.listen(8080);


function raiseNewWSServer(initialGamedata: Gamedata) {
    // is it excessive to use UUIDs for server names
    // (yes)
    // fun fact: this is the same UUID type that minecraft uses
    let upgradePath = v4();

    let wss = new WebSocketServer({noServer: true});

    // set up behavior
    wss.on('connection', function connection(ws) {
        ws.on('error', console.error);

        ws.on('message', function message(data) {
            try {
                let json = JSON.parse(data.toString());
                switch(json.command) {
                    case(WsCommand.chat):
                        ws.send(`{\"response\":0,\"uuid\":\"${json.uuid}\",\"message\":\"${json.message}\"}`);
                        break;
                    case(WsCommand.applySettings):
                        let outgoingData = pathSettings.get(upgradePath);
                        if(outgoingData != undefined) {
                            ws.send(settingsInformation(outgoingData));
                        }
                        break;
                    case(WsCommand.start):
                        //TODO: raise a gameserver here
                        break;
                    case(WsCommand.disband):
                        ws.send(`{\"response\":3}`);
                        ws.close(1000, `Owner of the room has closed this session.`);
                        cleanup(upgradePath);
                        break;
                    default:
                        break;
                }
            } catch(error) {
                // replace this once we finish debugging
                ws.send("Malformed data: " + error);
            }
        });
    })

    pathServer.set(upgradePath, wss);
    pathSettings.set(upgradePath, initialGamedata);
    return upgradePath;
}

async function updateDynamoTable(key: string) {
    let settings = pathSettings.get(key);
    let input;

    // the entity is shaped differently depending on whether the room is public or private
    if(settings?.isPrivate && settings.joinKey != undefined) {
        input = {
            "TableName":"sample-data",
            "Item": {
                "RoomId": {
                    "S" : key
                },
                "RoomName": {
                    "S" : settings.name
                },
                "CurrentCount": {
                    "N" : String(settings.players.size)
                },
                "MaxPlayers" : {
                    "N" : String(settings.maxPlayers)
                },
                "Host": {
                    "S" : settings.ownerUuid
                },
                "Private": {
                    "BOOL": true
                },
                "PrivateKey": {
                    "S": settings.joinKey
                },
                "Status": {
                    "N": String(settings.status)
                },
                "Players": {
                    "SS": Array.from(settings.players)
                }
            }
        }
        await client.send(new PutItemCommand(input));
    } else if(settings != undefined) {
        input = {
            "TableName":"sample-data",
            "Item": {
                "RoomId": {
                    "S" : key
                },
                "RoomName": {
                    "S" : settings.name
                },
                "CurrentCount": {
                    "N" : String(settings.players.size)
                },
                "MaxPlayers" : {
                    "N" : String(settings.maxPlayers)
                },
                "Host": {
                    "S" : settings.ownerUuid
                },
                "Private": {
                    "BOOL": false
                },
                "Status": {
                    "N": String(settings.status)
                },
                "Players": {
                    "SS": Array.from(settings.players)
                }
            }
        }
        await client.send(new PutItemCommand(input));
    }
}

async function cleanup(key:string) {
    pathServer.delete(key);
    pathSettings.delete(key);

    let input = {
        "TableName":"sample-data",
        "Key":{
            "RoomId":{
                "S":key
            }
        }
    }

    await client.send(new DeleteItemCommand(input));
}

// JSON parsing creates an equivalent of an anonymous class, so the incoming type can't be anything other than any
function createGamedata(json:any):Gamedata {
    let name : string = json.name;
    let ownerUuid : string = json.ownerUuid;
    let maxPlayers : number = json.maxPlayers;
    let isPrivate : boolean = json.isPrivate;
    let joinKey : string;
    let gamemode = json.gamemode;

    let gamedata = new Gamedata(name, ownerUuid, maxPlayers, isPrivate, gamemode);
    if(isPrivate) {
        joinKey = json.joinKey;
        gamedata.joinKey = joinKey;
    }
    return gamedata;
}

function settingsInformation(gamedata:Gamedata):string {
    return `{"response":1,"name":"${gamedata.name}","maxPlayers":"${gamedata.maxPlayers}","isPrivate":"${gamedata.isPrivate}","joinKey":"${gamedata.joinKey}","gamemode":0,"status":"0"}`;
};
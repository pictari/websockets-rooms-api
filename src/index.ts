import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 } from 'uuid';
import { Gamedata, Status } from './models/internal/gamedata';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

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

    if(req.method === 'POST') {
        let gamedata : Gamedata;
        try {
            let name : string = resultingJson.name
            let ownerUuid : string = resultingJson.ownerUuid;
            let maxPlayers : number = resultingJson.maxPlayers;
            let isPrivate : boolean = resultingJson.isPrivate;
            let joinKey : string;
            let gamemode = resultingJson.gamemode;

            gamedata = new Gamedata(name, ownerUuid, maxPlayers, isPrivate, gamemode);
            if(isPrivate) {
                joinKey = resultingJson.joinKey;
                gamedata.joinKey = joinKey;
            }
        } catch(error) {
            res.writeHead(400, { "content-type": "text/html" });
            res.end("The request body contains malformed JSON.\n\n" + error);
            return;
        }
        let newPath = raiseNewWSServer(gamedata);
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
})

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
            let json = JSON.parse(data.toString());
        })
    })

    pathServer.set(upgradePath, wss);
    pathSettings.set(upgradePath, initialGamedata);
    return upgradePath;
}

async function updateDynamoTable(key: string) {
    let settings = pathSettings.get(key);
    let input;
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
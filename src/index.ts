import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 } from 'uuid';
import { Gamedata, Status } from './models/internal/gamedata';
import { DeleteItemCommand, DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { WsCommand } from './models/internal/wscommand';

const pathServer: Map<string, WebSocketServer> = new Map();
const pathSettings: Map<string, Gamedata> = new Map();
const client: DynamoDBClient = new DynamoDBClient({});

// https://medium.com/@libinthomas33/building-a-crud-api-server-in-node-js-using-http-module-9fac57e2f47d
const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow all origins, or set a specific domain (e.g., 'https://example.com')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS'); // Allow specific methods
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Allow specific headers
    res.setHeader('Access-Control-Allow-Credentials', 'true'); // Allow credentials (cookies, etc.)

    if(req.method === 'OPTIONS') {
                
        res.writeHead(204);
        res.end();
        return;
    }

    let body = "";
    let resultingJson: any;
    // try to manually read data
    try {
        req.on("data", (chunk) => {
            body += chunk;
        });

        req.on("end", () => {
            resultingJson = JSON.parse(body.toString());
            
            // make the server with initial gamedata
            if (req.method === 'POST') {
                let gamedata: Gamedata;
                try {
                    gamedata = createGamedata(resultingJson);
                } catch (error) {
                    res.writeHead(400, { "content-type": "text/html" });
                    res.end("The request body contains malformed JSON.\n\n" + error);
                    return;
                }
                let newPath = raiseNewWSServer(gamedata);
                //updateDynamoTable(newPath);
                res.writeHead(201, { "content-type": "application/json" });
                res.end(`{ "newServerPath": \"${newPath}\" }`);
            }       
        });
    } catch (error) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end("Error parsing your request body. This server only accepts JSON.\n\n" + error);
        return;
    }
});

server.on('upgrade', function upgrade(request, socket, head) {
    // change base url when we get a domain
    let pathName = new URL(request.url as string, 'ws://localhost:8080');
    let found: boolean = false;

    console.log(pathServer.size);
    // cycle through all the active "sub"servers
    for (let key of pathServer.keys()) {
        if (pathName.pathname.toString() === '/' + key) {
            if (pathSettings.get(key)?.status == Status.waiting) {
                found = true;
                let wss = pathServer.get(key);
                wss?.handleUpgrade(request, socket, head, function done(ws) {
                    if (wss != undefined) {
                        wss.emit('connection', ws, request);
                    }
                })
                break;
            }
        }
    }

    if (!found) {
        socket.destroy();
    }
});

server.listen(8080);


function raiseNewWSServer(initialGamedata: Gamedata) {
    // is it excessive to use UUIDs for server names
    // (yes)
    // fun fact: this is the same UUID type that minecraft uses
    let upgradePath = v4();

    let wss = new WebSocketServer({ noServer: true });

    // set up behavior
    wss.on('connection', function connection(ws, req) {
        ws.on('error', console.error);

        ws.on('message', function message(data) {
            try {
                let json = JSON.parse(data.toString());
                switch (json.command) {
                    case (WsCommand.chat):
                        wss.clients.forEach(function each(client) {
                            if (client !== ws && client.readyState === WebSocket.OPEN) {
                                client.send(`{\"response\":0,\"uuid\":\"${json.uuid}\",\"message\":\"${json.message}\"}`);
                            }
                        });
                        break;
                    case (WsCommand.applySettings):
                        let currentData = pathSettings.get(upgradePath);
                        if (currentData != undefined) {
                            updateGamedata(json, currentData);
                            //updateDynamoTable(upgradePath);
                            wss.clients.forEach(function each(client) {
                                if (client !== ws && client.readyState === WebSocket.OPEN) {
                                    if (currentData != undefined) {
                                        client.send(settingsInformation(currentData));
                                    }
                                }
                            });
                        }
                        break;
                    case (WsCommand.start):
                        //TODO: raise a gameserver here
                        break;
                    case (WsCommand.disband):
                        wss.clients.forEach(function each(client) {
                            if (client !== ws && client.readyState === WebSocket.OPEN) {
                                client.send(`{\"response\":3}`);
                                client.close(1000, `Owner of the room has closed this session.`);
                            }
                        });
                        cleanup(upgradePath);
                        break;
                    default:
                        break;
                }
            } catch (error) {
                // replace this once we finish debugging
                wss.clients.forEach(function each(client) {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send("Malformed data: " + error);
                    }
                });
            }
        });
    });

    pathServer.set(upgradePath, wss);
    pathSettings.set(upgradePath, initialGamedata);
    return upgradePath;
}

async function updateDynamoTable(key: string) {
    let settings = pathSettings.get(key);
    let input;

    // the entity is shaped differently depending on whether the room is public or private
    if (settings?.isPrivate && settings.joinKey != undefined) {
        input = {
            "TableName": "sample-data",
            "Item": {
                "RoomId": {
                    "S": key
                },
                "RoomName": {
                    "S": settings.name
                },
                "CurrentCount": {
                    "N": String(settings.players.size)
                },
                "MaxPlayers": {
                    "N": String(settings.maxPlayers)
                },
                "Host": {
                    "S": settings.ownerUuid
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
    } else if (settings != undefined) {
        input = {
            "TableName": "sample-data",
            "Item": {
                "RoomId": {
                    "S": key
                },
                "RoomName": {
                    "S": settings.name
                },
                "CurrentCount": {
                    "N": String(settings.players.size)
                },
                "MaxPlayers": {
                    "N": String(settings.maxPlayers)
                },
                "Host": {
                    "S": settings.ownerUuid
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

async function cleanup(key: string) {
    pathServer.delete(key);
    pathSettings.delete(key);

    let input = {
        "TableName": "sample-data",
        "Key": {
            "RoomId": {
                "S": key
            }
        }
    }

    await client.send(new DeleteItemCommand(input));
}

// JSON parsing creates an equivalent of an anonymous class, so the incoming type can't be anything other than any
function createGamedata(json: any): Gamedata {
    let name: string = json.name;
    let ownerUuid: string = json.ownerUuid;
    let maxPlayers: number = json.maxPlayers;
    let isPrivate: boolean = json.isPrivate;
    let joinKey: string;
    let gamemode = json.gamemode;

    let gamedata = new Gamedata(name, ownerUuid, maxPlayers, isPrivate, gamemode);
    if (isPrivate) {
        joinKey = json.joinKey;
        gamedata.joinKey = joinKey;
    }
    return gamedata;
}

// similar function to above, except it uses an extant gamedata and can be partial
function updateGamedata(json: any, gamedata: Gamedata) {
    let name: string = json.name;
    if (name != undefined && name != null) {
        gamedata.name = name;
    }

    let maxPlayers: number = json.maxPlayers;
    if (maxPlayers != undefined && maxPlayers != null) {
        gamedata.maxPlayers = maxPlayers;
    }

    let isPrivate: boolean = json.isPrivate;
    if (isPrivate != undefined && isPrivate != null) {
        gamedata.isPrivate = isPrivate;
    }

    if (gamedata.isPrivate) {
        let joinKey: string = json.joinKey;
        if (joinKey != undefined && joinKey != null) {
            gamedata.joinKey = joinKey;
        }
    }
}

function settingsInformation(gamedata: Gamedata): string {
    return `{"response":1,"name":"${gamedata.name}","maxPlayers":"${gamedata.maxPlayers}","isPrivate":"${gamedata.isPrivate}","joinKey":"${gamedata.joinKey}","gamemode":0,"status":"0"}`;
};
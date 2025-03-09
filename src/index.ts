import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 } from 'uuid';
import { Gamedata, Status } from './models/internal/gamedata';
import { DeleteItemCommand, DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { WsCommand } from './models/internal/wscommand';
import { WsGamedata } from './models/internal/wsgamedata';
import { verifyJWT } from './jwthelpers';
import { WsResponse } from './models/internal/wsresponse';
import { SettingsResponse } from './models/internal/json_objects/settingsResponse';
import { Player, ReadyStatus } from './models/internal/json_objects/player';
import { PlayerResponse } from './models/internal/json_objects/playerResponse';

const pathServer: Map<string, WsGamedata> = new Map();
const client: DynamoDBClient = new DynamoDBClient({});

// https://medium.com/@libinthomas33/building-a-crud-api-server-in-node-js-using-http-module-9fac57e2f47d
const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allowed origins
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS'); // Allowed HTTP methods
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Allowed headers
    res.setHeader('Access-Control-Allow-Credentials', 'true'); // Allowed credentials

    if (req.method === 'OPTIONS') {

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
                let auth = req.headers.authorization;

                console.log(auth);

                if (auth == undefined || auth == null) {
                    res.writeHead(401, { "content-type": "text/html" });
                    res.end("Missing authorization header. You must be logged in to create a room.");
                    return;
                }
                let extractedToken = auth?.toString().split(" ")[1];
                console.log(extractedToken);

                if (extractedToken == undefined || extractedToken == null) {
                    res.writeHead(401, { "content-type": "text/html" });
                    res.end("You must include a token in the authorization header in form of 'Authorization: [type] [token]'");
                    return;
                }
                let token = verifyJWT(extractedToken);

                if (token == null || token == undefined) {
                    res.writeHead(403, { "content-type": "text/html" });
                    res.end("Invalid JWT.");
                    return;
                }

                let uuid = token.uuid;

                if (uuid == undefined || uuid == null) {
                    res.writeHead(403, { "content-type": "text/html" });
                    res.end("Invalid JWT.");
                    return;
                }
                let gamedata: Gamedata;

                try {
                    gamedata = createGamedata(resultingJson, uuid);
                    gamedata.ownerUuid = uuid;
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
    // the query in this actually just uses UUID for now, until we get proper authorization going
    // change base url when we get a domain
    let pathName = new URL(request.url as string, 'ws://localhost:8080');
    let found: boolean = false;

    let query = pathName.searchParams.get("token");
    if (query == null || query == undefined || query.length == 0) {
        socket.destroy(new Error("No JWT supplied in the request."));
        return;
    }

    let decodedToken = verifyJWT(query);

    if (decodedToken == null || decodedToken == undefined) {
        socket.destroy(new Error("JWT verification failed."));
        return;
    }

    if (decodedToken.verified == null || decodedToken.verified == 0) {
        socket.destroy(new Error("Only verified users can join a game."));
        return;
    }

    // cycle through all the active "sub"servers
    for (let key of pathServer.keys()) {
        if (pathName.pathname.toString() === '/' + key) {
            if (pathServer.get(key)?.gamedata.status == Status.waiting) {
                found = true;
                let wss = pathServer.get(key)?.websockets;
                let gamedata = pathServer.get(key)?.gamedata;

                // typescript complains if this check doesn't exist even though we already check for a null...
                if (query != null) {
                    gamedata?.players.set(decodedToken.uuid, ReadyStatus.pending);
                }

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
        socket.destroy(new Error("Couldn't find a WebSockets server with that key."));
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
        // re-retrieve the token within the WS server
        const clientToken = new URL(req.url as string, 'ws://localhost:8080').searchParams.get("token");
        // keep references in the listener itself just in case
        const gamedataReference = initialGamedata;
        const path = upgradePath;

        // this shouldn't happen because this verification already happened on the UPGRADE request side, but just in case...
        if (clientToken == null) {
            ws.close(1000, `Your request got malformed when redirected to a WS server. Please contact an administrator.`);
            return;
        }

        //TODO: replace with a decoder without verification in case it's way more performant than passing the verification twice
        const decodedToken = verifyJWT(clientToken);
        if (decodedToken == null) {
            ws.close(1000, `Your request got malformed when redirected to a WS server. Please contact an administrator.`);
            return;
        }

        const uuid = decodedToken.uuid;

        // resend the current settings; refresh player list for everyone in the lobby
        ws.send(settingsInformation(initialGamedata));
        wss.clients.forEach(function each(client) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(playerInformation(initialGamedata));
            }
        });


        ws.on('error', console.error);

        // this never gets triggered and I'm not sure why - their documentation just says "emits on connection opened"
        ws.on('open', function handleOpen() {
            console.log("Open event fired")
        });

        ws.on('close', function handleClose() {
            gamedataReference.players.delete(uuid);
            //updateDynamoTable(upgradePath);
        })

        ws.on('message', function message(data) {
            try {
                let json = JSON.parse(data.toString());
                switch (json.command) {
                    case (WsCommand.chat):
                        wss.clients.forEach(function each(client) {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(`{\"response\":${WsResponse.chat},\"uuid\":\"${uuid}\",\"message\":\"${json.message}\"}`);
                            }
                        });
                        break;
                    case (WsCommand.applySettings):
                        if(uuid != gamedataReference.ownerUuid) {
                            ws.send(`{\"response\":${WsResponse.error}}`);
                            break;
                        }

                        let currentData = gamedataReference;
                        if (currentData != undefined) {
                            try {
                                updateGamedata(json, currentData);
                                //updateDynamoTable(upgradePath);
                                wss.clients.forEach(function each(client) {
                                    if (client.readyState === WebSocket.OPEN) {
                                        if (currentData != undefined) {
                                            client.send(settingsInformation(currentData));
                                        }
                                    }
                                });
                            } catch (error) {
                                ws.send(`{\"response\":${WsResponse.error}}`);
                            }
                        }
                        break;
                    case (WsCommand.start):
                        if(uuid != gamedataReference.ownerUuid) {
                            ws.send(`{\"response\":${WsResponse.error}}`);
                            break;
                        }

                        //TODO: raise a gameserver here
                        gamedataReference.status = Status.ongoing;
                        break;
                    case (WsCommand.disband):
                        if(uuid != gamedataReference.ownerUuid) {
                            ws.send(`{\"response\":${WsResponse.error}}`);
                            break;
                        }

                        wss.clients.forEach(function each(client) {
                            client.send(`{\"response\":${WsResponse.closeSession}}`);
                            client.close(1000, `Owner of the room has closed this session.`);
                        });
                        cleanup(path);
                        break;
                    case(WsCommand.ready):
                        gamedataReference.players.set(uuid, gamedataReference.players.get(uuid) ? ReadyStatus.pending : ReadyStatus.ready);
                        wss.clients.forEach(function each(client) {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(playerInformation(initialGamedata));
                            }
                        });
                        break;
                    case(WsCommand.finish):
                        if(uuid != gamedataReference.ownerUuid) {
                            ws.send(`{\"response\":${WsResponse.error}}`);
                            break;
                        }

                        gamedataReference.status = Status.waiting;
                        wss.clients.forEach(function each(client) {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(settingsInformation(gamedataReference));
                            }
                        });
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

    pathServer.set(upgradePath, new WsGamedata(initialGamedata, wss));
    return upgradePath;
}

async function updateDynamoTable(key: string) {
    let settings = pathServer.get(key)?.gamedata;
    let playersArray: string[] = [];

    if (settings != undefined) {
        for (let player of settings?.players.keys()) {
            playersArray.push(player);
        }
    }

    // the entity is shaped differently depending on whether the room is public or private
    // they also differ based on player count, as passing in a null array makes dynamo crash
    if (settings?.isPrivate && settings.joinKey != undefined) {
        let input;
        if(playersArray.length > 0) {
            input = {
                "TableName": "sample-data-with-sort",
                "Item": {
                    "RoomId": { "S": key },
                    "RoomName": { "S": settings.name },
                    "CurrentCount": { "N": String(settings.players.size) },
                    "MaxPlayers": { "N": String(settings.maxPlayers) },
                    "HostId": { "S": settings.ownerUuid },
                    "Private": { "N": "1" },
                    "JoinKey": { "S": settings.joinKey },
                    "Status": { "N": String(settings.status) },
                    "Players": { "SS": playersArray }
                }
            }
        } else {
            input = {
                "TableName": "sample-data-with-sort",
                "Item": {
                    "RoomId": { "S": key },
                    "RoomName": { "S": settings.name },
                    "CurrentCount": { "N": String(settings.players.size) },
                    "MaxPlayers": { "N": String(settings.maxPlayers) },
                    "HostId": { "S": settings.ownerUuid },
                    "Private": { "N": "1" },
                    "JoinKey": { "S": settings.joinKey },
                    "Status": { "N": String(settings.status) },
                }
            }
        }
        await client.send(new PutItemCommand(input));
    } else if (settings != undefined) {
        let input;
        if(playersArray.length > 0) {
            input = {
                "TableName": "sample-data-with-sort",
                "Item": {
                    "RoomId": { "S": key },
                    "RoomName": { "S": settings.name },
                    "CurrentCount": { "N": String(settings.players.size) },
                    "MaxPlayers": { "N": String(settings.maxPlayers) },
                    "HostId": { "S": settings.ownerUuid },
                    "Private": { "N": "0" },
                    "Status": { "N": String(settings.status) },
                    "Players": { "SS": playersArray }
                }
            }
        } else {
            input = {
                "TableName": "sample-data-with-sort",
                "Item": {
                    "RoomId": { "S": key },
                    "RoomName": { "S": settings.name },
                    "CurrentCount": { "N": String(settings.players.size) },
                    "MaxPlayers": { "N": String(settings.maxPlayers) },
                    "HostId": { "S": settings.ownerUuid },
                    "Private": { "N": "0" },
                    "Status": { "N": String(settings.status) }
                }
            }
        }
        await client.send(new PutItemCommand(input));
    }
}

async function cleanup(key: string) {
    pathServer.delete(key);

    let input = {
        "TableName": "sample-data-with-sort",
        "Key": {
            "RoomId": {
                "S": key
            }
        }
    }

    //TODO: fix dynamo first
    //await client.send(new DeleteItemCommand(input));
}

// JSON parsing creates an equivalent of an anonymous class, so the incoming type can't be anything other than any
function createGamedata(json: any, uuid: string): Gamedata {
    let name: string = json.name;
    let ownerUuid: string = uuid;
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
    return JSON.stringify(new SettingsResponse(gamedata.name, gamedata.maxPlayers, gamedata.isPrivate, gamedata.gamemode, gamedata.status, gamedata.joinKey));
};

function playerInformation(gamedata: Gamedata): string {
    let players: Player[] = [];

    for (let player of gamedata.players.keys()) {
        let t = gamedata.players.get(player);
        if(t != undefined) {
            players.push(new Player(player, t));
        }
    }

    return JSON.stringify(new PlayerResponse(players));
}

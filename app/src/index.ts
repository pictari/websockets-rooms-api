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
import dotenv from "dotenv";
import k8s from "@kubernetes/client-node";


dotenv.config();

const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const pathServer: Map<string, WsGamedata> = new Map();
const client : DynamoDBClient = new DynamoDBClient({
    region: process.env.DYNAMOREGION as string,
    credentials: {
        accessKeyId: process.env.DYNAMOPUBLICACCESSKEY as string,
        secretAccessKey: process.env.DYNAMOSECRETACCESSKEY as string
    }
});

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
                updateDynamoTable(newPath);
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
    let pathName = new URL(request.url as string, `ws://${process.env.WSDOMAIN}`);
    let found: boolean = false;

    let query = pathName.searchParams.get("token");
    if (query == null || query == undefined || query.length == 0) {
        socket.destroy();
        return;
    }

    let decodedToken = verifyJWT(query);

    if (decodedToken == null || decodedToken == undefined) {
        socket.destroy();
        return;
    }

    if (decodedToken.verified == null || decodedToken.verified == 0) {
        socket.destroy();
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
                    updateDynamoTable(key);
                    console.log("Set the player in the gamedata");
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
        socket.destroy();
    }
});

server.listen(8080);

async function spinUpGameserver(allowedUUIDs: string, ownerUUID: string): Promise<string> {
    // Initialize Kubernetes client
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
    
    const jwtSecret = process.env.JWTSECRET || '';

    try {
        // Generate a random suffix for the pod name
        const randomSuffix = Math.random().toString(36).substring(2, 10);
        
        // Fetch all pods in the pictari-gameservers namespace
        const res = await k8sApi.listNamespacedPod({namespace: 'pictari-gameservers'});
        const runningPods = res.items.filter(pod => pod.status?.phase === 'Running');
        
        // Extract used ports from running pod names (e.g., "gameserver-7222-abc123" -> 7222)
        const usedPorts = runningPods
            .map(pod => {
                const name = pod.metadata!.name!;
                const match = name.match(/^gameserver-(\d+)-[a-z0-9]+$/);
                return match ? parseInt(match[1], 10) : null;
            })
            .filter((port): port is number => port !== null);

        // Define all possible ports in the range 7220 to 7230
        const allPorts = Array.from({ length: 11 }, (_, i) => 7220 + i);

        // Determine free ports
        const freePorts = allPorts.filter(port => !usedPorts.includes(port));

        // Check if there are any free ports available
        if (freePorts.length === 0) {
            throw new Error('No free ports available in the range 7220 to 7230');
        }

        // Select the first available port
        const selectedPort = freePorts[0];
        
        // Create a unique pod name with the port and random suffix
        const podName = `gameserver-${selectedPort}-${randomSuffix}`;

        // Define the pod manifest based on the provided structure
        const podManifest: k8s.V1Pod = {
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: {
                name: podName,
                namespace: 'pictari-gameservers',
                labels: {
                    app: `gameserver-${selectedPort}`,
                    port: `${selectedPort}`
                }
            },
            spec: {
                restartPolicy: 'Never',
                containers: [
                    {
                        name: `gameserver-container`,
                        image: '905418467919.dkr.ecr.eu-west-1.amazonaws.com/pictari-gameserver@sha256:509119ab8f34abb296ff180b97313a3cf12feea7e48606fd730d2f159a9d575f',
                        ports: [
                            {
                                containerPort: selectedPort,
                                protocol: 'UDP'
                            }
                        ],
                        env: [
                            {
                                name: 'JWT_SECRET',
                                value: jwtSecret
                            },
                            {
                                name: 'ALLOWED_UUIDS',
                                value: allowedUUIDs
                            },
                            {
                                name: 'OWNER_UUID',
                                value: ownerUUID
                            },
                            {
                                name: 'PORT',
                                value: `${selectedPort}`
                            }
                        ]
                    }
                ]
            },
        };

        // Create the new pod
        await k8sApi.createNamespacedPod({namespace: 'pictari-gameservers', body: podManifest});

        // Wait for the pod to be ready
        console.log(`Waiting for pod ${podName} to be ready...`);
        let podReady = false;
        let retryCount = 0;
        const maxRetries = 30; // 1 minute timeout (30 * 2 seconds)
        
        while (!podReady && retryCount < maxRetries) {
            try {
                const pod = await k8sApi.readNamespacedPod({ 
                    namespace: 'pictari-gameservers', 
                    name: podName 
                });
                
                podReady = pod.status?.phase === 'Running' && 
                           pod.status?.containerStatuses?.[0]?.ready === true;
                
                if (!podReady) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    retryCount++;
                }
            } catch (error) {
                console.error(`Error checking pod status: ${error}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                retryCount++;
            }
        }

        if (!podReady) {
            throw new Error(`Pod ${podName} failed to reach ready state within timeout period`);
        }

        // Return the address with the selected port
        return `https://gameserver.pictari.app:${selectedPort}`;
    } catch (error) {
        console.error('Error creating game server:', error);
        throw error;
    }
}

function raiseNewWSServer(initialGamedata: Gamedata) {
    // is it excessive to use UUIDs for server names
    // (yes)
    // fun fact: this is the same UUID type that minecraft uses
    let upgradePath = v4();

    let wss = new WebSocketServer({ noServer: true });

    // set up behavior
    wss.on('connection', function connection(ws, req) {
        // re-retrieve the token within the WS server
        const clientToken = new URL(req.url as string, `ws://${process.env.WSDOMAIN}`).searchParams.get("token");
        // keep references in the listener itself just in case
        const gamedataReference = initialGamedata;
        const path = upgradePath;
        let isAlive = true;

    
        // this shouldn't happen because this verification already happened on the UPGRADE request side, but just in case...
        // also to conform to strict type checking
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

        // set up heartbeat
        const interval = setInterval(function ping() {
            if(gamedataReference.status == Status.closing) {
                console.log("Ignoring heartbeat for " + uuid + ": room " + path + " is closing.");
                return;
            }

            if(isAlive === false && uuid == gamedataReference.ownerUuid) {
                console.log(`The owner ${uuid} is not responding to the heartbeat. Closing room ${path}.`);
                gamedataReference.status = Status.closing;
                cleanup(path);
                wss.clients.forEach(function each(client) {
                    client.send(`{\"response\":${WsResponse.closeSession}}`);
                    client.close(1000, `Owner of the room has closed this session.`);
                });
                return;
            }
            else if(isAlive === false) return ws.terminate();

            isAlive = false;
            ws.ping();
            // wss.clients.forEach(function each(ws) {
            //   if (isAlive === false) return ws.terminate();
          
            //   isAlive = false;
            //   ws.ping();
            // });
          }, 30000);


        ws.on('error', console.error);

        // this never gets triggered and I'm not sure why - their documentation just says "emits on connection opened"
        ws.on('open', function handleOpen() {
            console.log("Open event fired")
        });

        ws.on('close', function handleClose() {
            console.log('Closing session for ' + uuid);
            clearInterval(interval);
            if(gamedataReference.status == Status.closing) {
                console.log('Refused to delete ' + uuid + " from the player list in " + path + ": This room is already in a closing state");
                return;
            }

            if(uuid == gamedataReference.ownerUuid) {
                console.log( uuid + " owns room " + path + " as it matches " + gamedataReference.ownerUuid + " and the room is automatically disbanded due to them leaving. Good night!");
                gamedataReference.status = Status.closing;
                cleanup(path);
                wss.clients.forEach(function each(client) {
                    client.send(`{\"response\":${WsResponse.closeSession}}`);
                    client.close(1000, `Owner of the room has closed this session.`);
                });
            } else {
                console.log('Attempting to delete ' + uuid + "from the player list in " + path);
                gamedataReference.players.delete(uuid);
                updateDynamoTable(path);
            }
        })

        ws.on('pong', function heartbeat() {
            console.log("Received pong event from " + uuid +  " for room " + path);
            isAlive = true;
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
                            ws.send(`{\"response\":${WsResponse.error}, \"message\":\"Only the owner of a room can execute this command.\"}`);
                            break;
                        }

                        let currentData = gamedataReference;
                        if (currentData != undefined) {
                            try {
                                updateGamedata(json, currentData);
                                updateDynamoTable(upgradePath);
                                wss.clients.forEach(function each(client) {
                                    if (client.readyState === WebSocket.OPEN) {
                                        if (currentData != undefined) {
                                            client.send(settingsInformation(currentData));
                                        }
                                    }
                                });
                            } catch (error) {
                                ws.send(`{\"response\":${WsResponse.error}, \"message\":\"Failed to update the current gamedata. Try again.\"}`);
                            }
                        }
                        break;
                    case (WsCommand.start):
                        if(uuid != gamedataReference.ownerUuid) {
                            ws.send(`{\"response\":${WsResponse.error}, \"message\":\"Only the owner of a room can execute this command.\"}}`);
                            break;
                        }

                        let validateReadiness: boolean = true;
                        for(let player in gamedataReference.players.keys()) {
                            if(gamedataReference.players.get(player) == ReadyStatus.pending) {
                                validateReadiness = false;
                                break;
                            }
                        }

                        if(!validateReadiness) {
                            ws.send(`{\"response\":${WsResponse.error}, \"message\":\"All players must be ready before starting a gameserver.\"}}`);
                            break;
                        }

                        const allowedUUIDs = Array.from(gamedataReference.players.keys()).join(',');
                        spinUpGameserver(allowedUUIDs, gamedataReference.ownerUuid).then((server_address) => {
                            wss.clients.forEach(function each(client) {
                                if (client.readyState === WebSocket.OPEN)
                                    client.send(`{\"response\":${WsResponse.gameServerDetails}, \"message\":\"${server_address}\"}`);
                            });
                            gamedataReference.status = Status.ongoing;
                        })
                        .catch((error) => {
                            ws.send(`{\"response\":${WsResponse.error}, \"message\":\"Failed to start a gameserver. Try again.\"}}`);
                            console.error("Failed to start a gameserver: ", error);
                        });


                        break;
                    case (WsCommand.disband):
                        if(uuid != gamedataReference.ownerUuid) {
                            ws.send(`{\"response\":${WsResponse.error}, \"message\":\"Only the owner of a room can execute this command.\"}}`);
                            break;
                        }

                        gamedataReference.status = Status.closing;
                        cleanup(path);
                        wss.clients.forEach(function each(client) {
                            client.send(`{\"response\":${WsResponse.closeSession}}`);
                            client.close(1000, `Owner of the room has closed this session.`);
                        });
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
                            ws.send(`{\"response\":${WsResponse.error}, \"message\":\"Only the owner of a room can execute this command.\"}}`);
                            break;
                        }

                        for(let player in gamedataReference.players.keys()) {
                            gamedataReference.players.set(player, ReadyStatus.pending);
                        }

                        gamedataReference.status = Status.waiting;
                        wss.clients.forEach(function each(client) {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(playerInformation(gamedataReference));
                                client.send(settingsInformation(gamedataReference));
                            }
                        });
                        break;
                    default:
                        break;
                }
            } catch (error) {
                // replace this once we finish debugging
                ws.send("Malformed data: " + error);
            }
        });
    });

    pathServer.set(upgradePath, new WsGamedata(initialGamedata, wss));
    return upgradePath;
}

async function updateDynamoTable(key: string) {
    let settings = pathServer.get(key)?.gamedata;
    let playersArray: string[] = [];

    if(settings == undefined) {
        return;
    }
    
    if(settings.status == Status.closing) {
        return;
    }

    for (let player of settings?.players.keys()) {
        playersArray.push(player);
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
    } else {
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
    console.log("Started cleanup for room " + key);
    let compositeKey = pathServer.get(key)?.gamedata.isPrivate;
    if(compositeKey == undefined) {
        console.log("Failed to validate privacy status of room " + key);
        return;
    }

    let input = {
        "TableName": "sample-data-with-sort",
        "Key": {
            "RoomId": {
                "S": key
            },
            "Private":{
                "N":  `${compositeKey ? 1 : 0}`
            }
        }
    }

    try {
        await client.send(new DeleteItemCommand(input));
    } catch(e) {
        console.log(e);
    }

    pathServer.delete(key);
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
        gamedata.joinKey = randomStringCreator(10);
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
        gamedata.joinKey = randomStringCreator(10);
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

/**
 * Internal function used in generating a random string based off of an already existing charset.
 * 
 * @param length The number of characters that the function should output.
 * @returns A randomly generated string of characters based on charset and the passed-in length.
 */
function randomStringCreator(length: number) {
    let newString = '';

    for (let i = 0; i < length; i++) {
        newString += charset.charAt(Math.floor(Math.random() * charset.length));
    }

    return newString;
}
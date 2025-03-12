import { WebSocketServer } from "ws";
import { Gamedata } from "./gamedata";

export class WsGamedata {
    gamedata:Gamedata;
    websockets:WebSocketServer;

    constructor(gamedata:Gamedata, websockets:WebSocketServer) {
        this.gamedata = gamedata;
        this.websockets = websockets;
    }
}
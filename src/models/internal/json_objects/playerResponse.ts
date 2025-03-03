import { WsResponse } from "../wsresponse";
import { Player } from "./player";

export class PlayerResponse {
    response:WsResponse = WsResponse.playersUpdate;
    players:Player[];

    constructor(players:Player[]) {
        this.players = players;
    }
}
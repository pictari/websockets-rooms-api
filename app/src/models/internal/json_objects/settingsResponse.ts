import { Gamemode, Status } from "../gamedata";
import { WsResponse } from "../wsresponse";

export class SettingsResponse {
    response:WsResponse = WsResponse.settingsUpdate;
    settings: Settings;

    constructor(name:string,maxPlayers:number,isPrivate:boolean,gamemode:Gamemode,status:Status,joinKey?:string) {
        this.settings = new Settings(name, maxPlayers, isPrivate, gamemode, status, joinKey)
    }
}

class Settings {
    name:string;
    maxPlayers:number;
    isPrivate:boolean;
    joinKey?:string;
    gamemode:Gamemode;
    status:Status;

    constructor(name:string,maxPlayers:number,isPrivate:boolean,gamemode:Gamemode,status:Status,joinKey?:string) {
        this.name = name;
        this.maxPlayers = maxPlayers;
        this.isPrivate = isPrivate;
        this.joinKey = joinKey;
        this.gamemode = gamemode;
        this.status = status;
    }
}
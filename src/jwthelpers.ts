import { verify as jwtVerify } from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

export function verifyJWT(token:string): any | undefined {
    if(process.env.JWTSECRET == null) {
        console.log("Detected misconfigured JWT secret. No JWTs will be validated on this server!");
        return null;
    }

    const secret = process.env.JWTSECRET;

    try {
        const payload = jwtVerify(token, secret);
    } catch(error) {
        return null;
    }
}
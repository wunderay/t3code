import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

const endpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

/** The host and port agents reach this server's `/mcp` on, when it listens on TCP. */
export const localMcpAuthority = (address: HttpServer.HttpServer["Service"]["address"]) =>
  NetAddress.isInetAddress(address)
    ? `${endpointHost(address.address)}:${address.port}`
    : undefined;

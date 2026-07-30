import { Container } from "@cloudflare/containers";

export class OutlookImapGraphApi extends Container {
  defaultPort = 3000;
  requiredPorts = [3000];
  sleepAfter = "10m";
  enableInternet = true;
  pingEndpoint = "/healthz";
  envVars = {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "3000",
  };
}

export default {
  async fetch(request, env) {
    const container = env.OUTLOOK_API.getByName("singleton");
    return container.fetch(request);
  },
};

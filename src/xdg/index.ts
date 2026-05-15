import { homedir } from "node:os";
import { join } from "node:path";

export function stateHome(): string {
  const env = process.env["XDG_STATE_HOME"];
  if (env != null && env !== "") {
    return env;
  }
  return join(homedir(), ".local", "state");
}

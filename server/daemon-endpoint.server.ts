import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_LISTEN = "127.0.0.1:6767";

// Демон, в котором запущен плагин: его адрес в config.json того же PASEO_HOME.
// Без этого тестовый демон с отдельным PASEO_HOME добавлял и менял проекты живого Paseo.
export async function daemonListen(home: string): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(join(home, "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_LISTEN;
    throw error;
  }
  const config = JSON.parse(contents) as { daemon?: { listen?: unknown } };
  const listen = config.daemon?.listen;
  if (listen === undefined) return DEFAULT_LISTEN;
  if (typeof listen !== "string" || !/^[\w.-]+:\d+$/.test(listen)) {
    throw new Error("Unsupported daemon listen in " + join(home, "config.json"));
  }
  return listen;
}

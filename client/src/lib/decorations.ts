// The decorations in src/decorations, one `.deco` file each (the format is
// in src/decorations/README.md), parsed once when the app starts.
import { Deco, parseDeco } from "./deco";

const files = import.meta.glob("../decorations/*.deco", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const DECORATIONS: Deco[] = Object.entries(files)
  .flatMap(([path, text]) => {
    const id = path.slice(path.lastIndexOf("/") + 1, -".deco".length);
    try {
      return [parseDeco(id, text)];
    } catch (e) {
      // One broken drawing must not take the app down with it.
      console.error(e);
      return [];
    }
  })
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

const byId = new Map(DECORATIONS.map((d) => [d.id, d]));

export const decorationById = (id?: string | null) => (id ? byId.get(id) : undefined);

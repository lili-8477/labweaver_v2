// The router and its toolsets dispatch through handler tables typed by the RPC
// contract (src/rpc-contract.ts): what they answer, and what they refuse.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RpcRouter, type RpcDeps } from "../src/rpc.js";
import type { FileManagerMethods, NotebookMethods } from "../src/rpc-contract.js";

function router() {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "rpc-contract-"));
  const deps: RpcDeps = {
    serviceId: "svc",
    workspaceRoot,
    chats: {} as RpcDeps["chats"],
    home: workspaceRoot,
    defaultProjectCwd: workspaceRoot,
    publishStream: () => undefined,
    publishRaw: () => undefined,
    streamSubject: (id) => `pantheon.stream.${id}`,
    kernelBridgePath: "/dev/null",
    kernelIdleCullMs: 0,
    kernelCullCheckIntervalMs: 60_000,
    memory: null,
    share: null,
    engine: { runTurn: async () => undefined, close: async () => undefined },
    providers: [],
  };
  return { rpc: new RpcRouter(deps), workspaceRoot };
}

describe("RpcRouter", () => {
  it("answers contract methods and refuses anything else, prototype names included", async () => {
    const { rpc } = router();
    expect(await rpc.dispatch("get_endpoint", {})).toEqual({ success: true, service_id: "svc" });
    for (const method of ["toString", "constructor", "__proto__", "no_such_method"]) {
      await expect(rpc.dispatch(method, {})).rejects.toThrow(/unknown method/);
    }
  });

  it("routes proxy_toolset by toolset, with each method's own param names", async () => {
    const { rpc, workspaceRoot } = router();
    writeFileSync(path.join(workspaceRoot, "a.txt"), "hello");
    const call = (toolset_name: string, method_name: string, args: object) =>
      rpc.dispatch("proxy_toolset", { toolset_name, method_name, args });

    const list = await call("file_manager", "list_files", { sub_dir: null } satisfies FileManagerMethods["list_files"]["params"]);
    expect(list).toMatchObject({ success: true, files: [expect.objectContaining({ name: "a.txt", type: "file" })] });
    expect(await call("file_manager", "read_file", { file_path: "a.txt" })).toMatchObject({ content: "hello", encoding: "utf8" });

    await call("notebook", "create_notebook", { notebook_path: "n.ipynb" } satisfies NotebookMethods["create_notebook"]["params"]);
    const added = await call("notebook", "add_cell", { notebook_path: "n.ipynb", content: "1+1", position: null });
    expect(added).toMatchObject({ success: true, cell_count: 1, notebook: { cells: [expect.objectContaining({ source: "1+1" })] } });

    await expect(call("file_manager", "hasOwnProperty", {})).rejects.toThrow(/unknown method/);
    await expect(call("spreadsheet", "list_files", {})).rejects.toThrow(/unknown toolset/);
  });
});

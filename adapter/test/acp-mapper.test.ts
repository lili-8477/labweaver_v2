import { describe, expect, it } from "vitest";
import { mapSessionUpdate } from "../src/dsh/acp-mapper.js";

// Fixtures are verbatim shapes captured from `dsh --profile acp` 0.2.0-rc.2.
describe("mapSessionUpdate", () => {
  it("maps committed text blocks", () => {
    expect(mapSessionUpdate({
      sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Let me look. " },
    })).toEqual([{ kind: "text", text: "Let me look. " }]);
    expect(mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } })).toEqual([]);
  });

  it("maps tool lifecycle", () => {
    expect(mapSessionUpdate({
      sessionUpdate: "tool_call", toolCallId: "call_1", title: "bash", kind: "other", status: "in_progress",
      rawInput: { command: "echo hi" },
    })).toEqual([{ kind: "tool_call", id: "call_1", name: "bash", input: { command: "echo hi" } }]);

    expect(mapSessionUpdate({
      sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "failed",
      content: [{ type: "content", content: { type: "text", text: "Error: tool call aborted" } }],
    })).toEqual([{ kind: "tool_result", id: "call_1", output: "Error: tool call aborted", isError: true }]);

    expect(mapSessionUpdate({
      sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "line1" } },
        { type: "content", content: { type: "text", text: "line2" } },
      ],
    })).toEqual([{ kind: "tool_result", id: "call_1", output: "line1\nline2", isError: false }]);
  });

  it("ignores non-terminal tool updates and unsupported variants", () => {
    expect(mapSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "in_progress" })).toEqual([]);
    expect(mapSessionUpdate({
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" },
    })).toEqual([]);
  });

  it("maps usage", () => {
    expect(mapSessionUpdate({ sessionUpdate: "usage_update", used: 7012, size: 131072 }))
      .toEqual([{ kind: "usage", contextTokens: 7012, contextWindow: 131072 }]);
  });
});

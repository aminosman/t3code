#!/usr/bin/env python3
"""Measures how agents route a request for another agent (Roost, Oct 5 2026).

Amin: "nest owned and unnest non owned … we need to make sure the agent knows
when to use each and be careful with that." Each case is a request Amin really
made, labeled with what he meant:

  owned     delegate_task: this thread wants the result back (drawn under it)
  separate  t3_thread_launch / create_threads: stands on its own (top level)
  here      no new agent: do it in this thread, or message an existing one

The model under test gets the instructions every Roost agent gets
(buildRuntimeInstructions + upstream's orchestration block) and the real MCP
tool schemas, both loaded from this checkout, plus a shell and file reader.
Tools that only look things up answer with stubs, for up to eight rounds; the
first agent-starting call is the answer, and a reply with none is "here".

  python3 scripts/spawn-routing-eval.py --cases cases.json \
      --models anthropic/claude-opus-5.5,gpt-6.1-sol [--repeat 2] [--out results.json]

A model with a "/" goes through OpenRouter (openrouter.api_key); gpt-* goes to
OpenAI; anything else to Anthropic.

Keys: anthropic.api_key and openai.api_key in ~/.config/kea/config.json, or
ANTHROPIC_API_KEY / OPENAI_API_KEY. A harness adds its own long prompt in
front of these instructions; this measures the instructions, not the harness.
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Rounds of stubbed tool calls before a run with no agent started counts as "here".
ROUNDS = 8
SERVER = ROOT / "apps" / "server"

SPAWN_LABEL = {
    "delegate_task": "owned",
    "t3_thread_launch": "separate",
    "create_threads": "separate",
}
OFFERED = [
    "orchestrator_capabilities",
    "delegate_task",
    "task_status",
    "create_threads",
    "t3_thread_launch",
    "t3_project_list",
    "t3_project_create",
    "t3_history_search",
    "t3_any_thread_list",
    "t3_any_thread_read",
    "t3_model_list",
    "t3_any_thread_send",
    "t3_any_thread_wait",
]
LOCAL_TOOLS = {
    "bash": {
        "description": "Run a shell command in the project's checkout and return its output.",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    },
    "read_file": {
        "description": "Read a file from the project's checkout.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
}
MODEL_CATALOG = {
    "providers": [
        {
            "instanceId": "claudeAgent",
            "provider": "claudeAgent",
            "current": True,
            "usage": [{"label": "Weekly", "usedPercent": 11}],
            "models": [
                {"model": "claude-opus-5-5", "current": True, "options": [{"id": "effort"}]},
                {"model": "claude-fable-5-1", "current": False, "options": [{"id": "effort"}]},
                {"model": "claude-sonnet-5-5", "current": False, "options": [{"id": "effort"}]},
            ],
        },
        {
            "instanceId": "codex",
            "provider": "codex",
            "current": False,
            "usage": [{"label": "Weekly", "usedPercent": 19}],
            "models": [
                {"model": "gpt-6.1-sol", "options": [{"id": "reasoningEffort"}]},
                {"model": "gpt-6-astra", "options": [{"id": "reasoningEffort"}]},
            ],
        },
    ]
}
HARNESS_PREAMBLE = (
    "You are a coding agent working for the user in T3 Code (Roost), in the project "
    "named below. You have a shell and can read files in the project's checkout, and the "
    "t3-code MCP tools. Act on the user's message: use tools when they help, and reply "
    "in text when you are done or need to ask."
)


def load_prompt_and_tools(server: pathlib.Path) -> tuple[str, list[dict]]:
    script = """
const { buildRuntimeInstructions } = await import(process.cwd() + "/src/provider/RuntimeInstructions.ts");
const { T3_CODE_ORCHESTRATION_INSTRUCTIONS } = await import(process.cwd() + "/src/provider/T3OrchestrationInstructions.ts");
const kits = [
  (await import(process.cwd() + "/src/mcp/toolkits/orchestrator/tools.ts")).OrchestratorToolkit,
  (await import(process.cwd() + "/src/mcp/toolkits/project/tools.ts")).ProjectToolkit,
  (await import(process.cwd() + "/src/mcp/toolkits/threads/tools.ts")).ThreadsToolkit,
];
const { Tool } = await import("effect/unstable/ai");
const tools = {};
for (const kit of kits)
  for (const [name, tool] of Object.entries(kit.tools))
    tools[name] = { description: tool.description, parameters: Tool.getJsonSchema(tool) };
console.log(JSON.stringify({
  prompt: buildRuntimeInstructions({ harness: "Claude Code" }) + "\\n" + T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  tools,
}));
"""
    path = server / ".spawn-routing-dump.mts"
    path.write_text(script)
    try:
        out = subprocess.run(
            ["node", path.name], cwd=server, capture_output=True, text=True, check=True
        ).stdout
    finally:
        path.unlink(missing_ok=True)
    data = json.loads(out)
    tools = [{"name": name, **data["tools"][name]} for name in OFFERED if name in data["tools"]]
    missing = [name for name in OFFERED if name not in data["tools"]]
    if missing:
        print(f"note: not in this checkout: {', '.join(missing)}", file=sys.stderr)
    tools += [{"name": name, **spec} for name, spec in LOCAL_TOOLS.items()]
    return data["prompt"], tools


def config_key(section: str, env: str) -> str:
    if os.environ.get(env):
        return os.environ[env]
    config = json.loads((pathlib.Path.home() / ".config/kea/config.json").read_text())
    return config[section]["api_key"]


def post(url: str, headers: dict, body: dict) -> dict:
    for attempt in range(5):
        request = urllib.request.Request(
            url, data=json.dumps(body).encode(), headers={"content-type": "application/json", **headers}
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code in (429, 500, 502, 503, 529) and attempt < 4:
                time.sleep(4 * (attempt + 1))
                continue
            raise RuntimeError(f"{error.code}: {error.read()[:400]!r}") from error
    raise RuntimeError("unreachable")


def stub_result(name: str) -> str:
    if name in ("t3_model_list", "orchestrator_capabilities"):
        return json.dumps(MODEL_CATALOG)
    if name == "t3_project_list":
        return json.dumps({"projects": [{"title": t} for t in ("tui", "careday", "flighted-wedge", "Family Law", "snippets", "t3code")]})
    if name == "t3_project_create":
        return json.dumps({"projectId": "project-new", "title": "new project", "created": True})
    if name in ("bash", "read_file"):
        return "(ran; the output matches what the conversation so far describes)"
    return "(no further results in this evaluation)"


# The cases are single messages lifted from long threads. What they point at
# ("this change", "C3", a pasted analysis) was in the real conversation; told
# nothing, a careful model stops to ask for it, which measures the excerpt,
# not the routing.
CONTEXT_NOTE = (
    "(Everything this message refers to — the change, the plan, the list, the pasted "
    "analysis, the earlier findings — is in the conversation above and you know it in full. "
    "Act on the message.)"
)


def user_message(case: dict) -> str:
    earlier = f"[Earlier in this thread — {case['context']}]\n\n" if case.get("context") else ""
    return f"{earlier}{CONTEXT_NOTE}\n\n{case['request']}"


def run_anthropic(model: str, system: str, tools: list[dict], case: dict) -> dict:
    key = config_key("anthropic", "ANTHROPIC_API_KEY")
    messages = [{"role": "user", "content": user_message(case)}]
    tool_specs = [
        {"name": t["name"], "description": t["description"], "input_schema": t["parameters"]}
        for t in tools
    ]
    trace = []
    for _ in range(ROUNDS):
        reply = post(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": key, "anthropic-version": "2023-06-01"},
            {"model": model, "max_tokens": 4000, "system": system, "tools": tool_specs, "messages": messages},
        )
        calls = [block for block in reply["content"] if block["type"] == "tool_use"]
        text = " ".join(block.get("text", "") for block in reply["content"] if block["type"] == "text")
        for call in calls:
            trace.append(call["name"])
            if call["name"] in SPAWN_LABEL or call["name"] == "t3_any_thread_send":
                return {"tool": call["name"], "input": call["input"], "text": text, "trace": trace}
        if not calls:
            return {"tool": None, "text": text, "trace": trace}
        messages.append({"role": "assistant", "content": reply["content"]})
        messages.append({
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": call["id"], "content": stub_result(call["name"])}
                for call in calls
            ],
        })
    return {"tool": None, "text": f"(still looking after {ROUNDS} rounds)", "trace": trace}


def run_openai(model: str, system: str, tools: list[dict], case: dict) -> dict:
    key = config_key("openai", "OPENAI_API_KEY")
    tool_specs = [
        {"type": "function", "name": t["name"], "description": t["description"], "parameters": t["parameters"]}
        for t in tools
    ]
    items: list = [{"role": "user", "content": user_message(case)}]
    trace = []
    for _ in range(ROUNDS):
        reply = post(
            "https://api.openai.com/v1/responses",
            {"authorization": f"Bearer {key}"},
            {"model": model, "instructions": system, "tools": tool_specs, "input": items},
        )
        calls = [item for item in reply["output"] if item["type"] == "function_call"]
        text = " ".join(
            part.get("text", "")
            for item in reply["output"]
            if item["type"] == "message"
            for part in item.get("content", [])
        )
        for call in calls:
            trace.append(call["name"])
            if call["name"] in SPAWN_LABEL or call["name"] == "t3_any_thread_send":
                return {"tool": call["name"], "input": json.loads(call["arguments"] or "{}"), "text": text, "trace": trace}
        if not calls:
            return {"tool": None, "text": text, "trace": trace}
        items += reply["output"]
        items += [
            {"type": "function_call_output", "call_id": call["call_id"], "output": stub_result(call["name"])}
            for call in calls
        ]
    return {"tool": None, "text": f"(still looking after {ROUNDS} rounds)", "trace": trace}


def run_openrouter(model: str, system: str, tools: list[dict], case: dict) -> dict:
    """Claude models, through OpenRouter's chat completions (anthropic/… slugs)."""
    key = config_key("openrouter", "OPENROUTER_API_KEY")
    tool_specs = [
        {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}}
        for t in tools
    ]
    messages: list = [{"role": "system", "content": system}, {"role": "user", "content": user_message(case)}]
    trace = []
    for _ in range(ROUNDS):
        reply = post(
            "https://openrouter.ai/api/v1/chat/completions",
            {"authorization": f"Bearer {key}"},
            {"model": model, "messages": messages, "tools": tool_specs, "max_tokens": 4000},
        )
        message = reply["choices"][0]["message"]
        calls = message.get("tool_calls") or []
        text = message.get("content") or ""
        for call in calls:
            name = call["function"]["name"]
            trace.append(name)
            if name in SPAWN_LABEL or name == "t3_any_thread_send":
                return {"tool": name, "input": json.loads(call["function"]["arguments"] or "{}"), "text": text, "trace": trace}
        if not calls:
            return {"tool": None, "text": text, "trace": trace}
        messages.append({"role": "assistant", "content": text, "tool_calls": calls})
        messages += [
            {"role": "tool", "tool_call_id": call["id"], "content": stub_result(call["function"]["name"])}
            for call in calls
        ]
    return {"tool": None, "text": f"(still looking after {ROUNDS} rounds)", "trace": trace}


def answer_label(result: dict) -> str:
    return SPAWN_LABEL.get(result.get("tool") or "", "here")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True)
    parser.add_argument("--models", default="claude-opus-5-5")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--only", help="comma-separated case ids")
    parser.add_argument("--out")
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument(
        "--checkout",
        help="another checkout whose instructions and tools to measure (default: this one)",
    )
    args = parser.parse_args()

    server = pathlib.Path(args.checkout) / "apps" / "server" if args.checkout else SERVER
    system_tail, tools = load_prompt_and_tools(server)
    system = f"{HARNESS_PREAMBLE}\n\n{system_tail}"
    cases = json.loads(pathlib.Path(args.cases).read_text())
    if args.only:
        wanted = set(args.only.split(","))
        cases = [case for case in cases if case["id"] in wanted]

    report = {"models": {}, "cases": len(cases)}
    for model in args.models.split(","):
        runner = (
            run_openrouter if "/" in model else run_openai if model.startswith("gpt") else run_anthropic
        )
        jobs = [(case, n) for case in cases for n in range(args.repeat)]

        def one(job):
            case, n = job
            try:
                result = runner(model, system, tools, case)
            except Exception as error:  # noqa: BLE001 — recorded, not fatal
                result = {"tool": None, "error": str(error)}
            return case, n, result

        rows = []
        with futures.ThreadPoolExecutor(args.jobs) as pool:
            for case, n, result in pool.map(one, jobs):
                got = "error" if "error" in result else answer_label(result)
                rows.append({"id": case["id"], "run": n, "label": case["label"], "got": got,
                             "confidence": case.get("confidence"), **result})
        scored = [row for row in rows if row["got"] != "error"]
        right = sum(row["got"] == row["label"] for row in scored)
        confusion: dict = {}
        for row in scored:
            confusion.setdefault(row["label"], {}).setdefault(row["got"], 0)
            confusion[row["label"]][row["got"]] += 1
        report["models"][model] = {
            "right": right,
            "scored": len(scored),
            "errors": len(rows) - len(scored),
            "confusion": confusion,
            "wrong": [
                {k: row[k] for k in ("id", "label", "got", "confidence", "tool", "trace") if k in row}
                | {"text": (row.get("text") or "")[:300]}
                for row in scored if row["got"] != row["label"]
            ],
            "rows": rows,
        }
        print(f"{model}: {right}/{len(scored)} right, {len(rows) - len(scored)} errors")
        for label, got in sorted(confusion.items()):
            print(f"  {label:8} -> {dict(sorted(got.items()))}")
        for row in report["models"][model]["wrong"]:
            print(f"  wrong: {row['id']} ({row['label']}, {row.get('confidence')}) -> {row['got']} via {row.get('trace')}")
    if args.out:
        pathlib.Path(args.out).write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

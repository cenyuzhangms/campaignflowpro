import asyncio
import os
import shutil
import sys
import tempfile
import traceback
from multiprocessing.connection import Listener

from agent_framework_claude import ClaudeAgent


def _claude_stderr(line: str):
    print(f"[Claude stderr] {line}")


def build_claude_options():
    claude_model = os.getenv("CLAUDE_AGENT_MODEL")
    claude_cli_path = os.getenv("CLAUDE_AGENT_CLI_PATH") or (
        shutil.which("claude.exe")
        or shutil.which("claude.cmd")
        or shutil.which("claude")
    )
    if not claude_cli_path:
        raise RuntimeError("Claude Code CLI not found on PATH. Install it or set CLAUDE_AGENT_CLI_PATH.")

    options = {
        "cli_path": claude_cli_path,
        "permission_mode": "bypassPermissions",
        "stderr": _claude_stderr,
        "cwd": tempfile.gettempdir(),
    }
    if claude_model:
        options["model"] = claude_model
    return options


async def run_request(instructions: str, prompt: str) -> str:
    options = build_claude_options()
    async with ClaudeAgent(
        instructions=instructions,
        default_options=options,
    ) as agent:
        result = await agent.run(prompt)
    return result.text if hasattr(result, "text") else str(result)


def run_request_sync(instructions: str, prompt: str) -> str:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    print(f"[ClaudeWorker] event loop: {type(loop).__name__}")
    try:
        return loop.run_until_complete(run_request(instructions, prompt))
    finally:
        loop.close()
        asyncio.set_event_loop(None)


def main():
    # NOTE: Do NOT set WindowsSelectorEventLoopPolicy here.
    # The default ProactorEventLoop is required for subprocess support on Windows,
    # which the Claude SDK needs to spawn claude.exe.

    address = ("127.0.0.1", int(os.getenv("CLAUDE_WORKER_PORT", "8769")))
    authkey = os.getenv("CLAUDE_WORKER_KEY", "carepath").encode()
    listener = Listener(address, authkey=authkey)
    print(f"[ClaudeWorker] listening on {address[0]}:{address[1]}")

    while True:
        try:
            conn = listener.accept()
        except ConnectionAbortedError:
            continue
        try:
            payload = conn.recv()
            if payload.get("type") == "shutdown":
                conn.send({"ok": True})
                conn.close()
                break
            if payload.get("type") == "ping":
                conn.send({"ok": True})
                conn.close()
                continue
            print("[ClaudeWorker] request received")
            instructions = payload.get("instructions", "")
            prompt = payload.get("prompt", "")
            result = run_request_sync(instructions, prompt)
            conn.send({"ok": True, "text": result})
        except Exception as exc:
            print("[ClaudeWorker] error:", exc)
            traceback.print_exc()
            try:
                conn.send({"ok": False, "error": str(exc)})
            except Exception:
                pass
        finally:
            try:
                conn.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()

import asyncio
import os
import shutil
from multiprocessing.connection import Client
from dataclasses import dataclass

from agent_framework import AgentResponse, AgentResponseUpdate, AgentThread, ChatMessage, ChatMessageStore


@dataclass
class AgentBundle:
    planner: object
    writer: object
    reviewer: object
    publisher: object


def build_agents() -> AgentBundle:
    try:
        from agent_framework_github_copilot import GitHubCopilotAgent
        from azure.ai.inference import ChatCompletionsClient
        from azure.ai.inference.models import SystemMessage, UserMessage
        from azure.core.credentials import AzureKeyCredential
    except Exception as exc:
        raise RuntimeError(
            "Required agent SDKs are missing. Install dependencies and configure credentials. "
            f"Details: {exc}"
        ) from exc

    copilot_model = os.getenv("GITHUB_COPILOT_AGENT_MODEL", "gpt-5.2")
    claude_model = os.getenv("CLAUDE_AGENT_MODEL")
    azure_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").strip()
    azure_deployment = os.getenv("AZURE_OPENAI_CHAT_DEPLOYMENT_NAME") or os.getenv("AZURE_OPENAI_DEPLOYMENT", "")
    azure_api_key = os.getenv("AZURE_OPENAI_API_KEY", "")
    azure_api_version = os.getenv("AZURE_OPENAI_API_VERSION", "").strip()

    cli_path = (
        shutil.which("copilot.cmd")
        or shutil.which("copilot.bat")
        or shutil.which("copilot")
    )
    if not cli_path:
        raise RuntimeError("GitHub Copilot CLI not found on PATH")

    planner = GitHubCopilotAgent(
        default_options={
            "instructions": "You are a marketing campaign planner who creates structured plans.",
            "model": copilot_model,
            "cli_path": cli_path,
        },
        name="Planner",
    )

    claude_worker_host = os.getenv("CLAUDE_WORKER_HOST", "127.0.0.1")
    claude_worker_port = int(os.getenv("CLAUDE_WORKER_PORT", "8769"))
    claude_worker_key = os.getenv("CLAUDE_WORKER_KEY", "carepath").encode()

    def _probe_claude_worker():
        try:
            conn = Client((claude_worker_host, claude_worker_port), authkey=claude_worker_key)
            conn.send({"type": "ping"})
            _ = conn.recv()
            conn.close()
            return True
        except OSError:
            return False

    if not _probe_claude_worker():
        raise RuntimeError(
            "Claude worker is not reachable. Start it with: python backend/claude_worker.py "
            f"(listening on {claude_worker_host}:{claude_worker_port})."
        )

    def _build_prompt(messages):
        if messages is None:
            return ""
        if isinstance(messages, str):
            return messages
        try:
            return "\n".join([m.text for m in messages if getattr(m, "text", None)])
        except Exception:
            return str(messages)

    class WorkerClaudeAgent:
        def __init__(self, name: str, instructions: str):
            self.name = name
            self.id = name.lower()
            self.instructions = instructions
            self.description = None

        def _call_worker(self, prompt: str) -> str:
            payload = {
                "instructions": self.instructions,
                "prompt": prompt,
            }
            conn = Client((claude_worker_host, claude_worker_port), authkey=claude_worker_key)
            conn.send(payload)
            response = conn.recv()
            conn.close()
            if not response.get("ok"):
                raise RuntimeError(response.get("error", "Claude worker error"))
            return response.get("text", "")

        async def run(self, messages=None, *, thread=None, **kwargs):
            prompt = _build_prompt(messages)
            text = await asyncio.to_thread(self._call_worker, prompt)
            msg = ChatMessage(role="assistant", text=text, author_name=self.name)
            return AgentResponse(messages=[msg])

        def run_stream(self, messages=None, *, thread=None, **kwargs):
            async def _stream():
                response = await self.run(messages, thread=thread, **kwargs)
                update = AgentResponseUpdate(text=response.text, role="assistant", author_name=self.name)
                yield update

            return _stream()

        def get_new_thread(self, **kwargs):
            return AgentThread(message_store=ChatMessageStore())

    writer = WorkerClaudeAgent(
        name="Writer",
        instructions="You are a senior marketing copywriter. Produce clear, channel-ready drafts.",
    )

    class AzureReviewerAgent:
        def __init__(self, endpoint: str, api_key: str, model: str):
            client_kwargs = {}
            if azure_api_version:
                client_kwargs["api_version"] = azure_api_version
            self.client = ChatCompletionsClient(
                endpoint=endpoint,
                credential=AzureKeyCredential(api_key),
                **client_kwargs,
            )
            self.model = model
            self.name = "Reviewer"
            self.id = "reviewer"
            self.description = None

        async def run(self, messages=None, *, thread=None, **kwargs):
            if messages is None:
                prompt = ""
            elif isinstance(messages, str):
                prompt = messages
            else:
                try:
                    prompt = "\n".join([m.text for m in messages])
                except Exception:
                    prompt = str(messages)

            response = await asyncio.to_thread(
                self.client.complete,
                model=self.model,
                messages=[
                    SystemMessage(
                        content=(
                            "You are a marketing compliance and quality reviewer. "
                            "Respond with JSON only: {\"approved\": true/false, \"feedback\": \"...\", \"risk_notes\": \"...\"}."
                        )
                    ),
                    UserMessage(content=prompt),
                ],
            )
            text = "No response from Azure reviewer."
            if response and response.choices:
                text = response.choices[0].message.content
            msg = ChatMessage(role="assistant", text=text, author_name=self.name)
            return AgentResponse(messages=[msg])

        def run_stream(self, messages=None, *, thread=None, **kwargs):
            async def _stream():
                response = await self.run(messages, thread=thread, **kwargs)
                update = AgentResponseUpdate(text=response.text, role="assistant", author_name=self.name)
                yield update

            return _stream()

        def get_new_thread(self, **kwargs):
            return AgentThread(message_store=ChatMessageStore())

    if azure_endpoint and not azure_endpoint.startswith(("http://", "https://")):
        azure_endpoint = f"https://{azure_endpoint}"

    if not azure_endpoint or not azure_api_key:
        raise RuntimeError(
            "Azure OpenAI credentials are missing. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY."
        )

    # azure-ai-inference ChatCompletionsClient expects the deployment in the endpoint URL
    deployment = azure_deployment or "gpt-4o-mini"
    reviewer_endpoint = azure_endpoint.rstrip("/")
    if "/openai/deployments/" not in reviewer_endpoint:
        reviewer_endpoint = f"{reviewer_endpoint}/openai/deployments/{deployment}"

    reviewer = AzureReviewerAgent(
        endpoint=reviewer_endpoint,
        api_key=azure_api_key,
        model=deployment,
    )

    publisher = WorkerClaudeAgent(
        name="Publisher",
        instructions="You are a publisher. Finalize the approved copy and prepare a publish-ready package.",
    )

    return AgentBundle(
        planner=planner,
        writer=writer,
        reviewer=reviewer,
        publisher=publisher,
    )

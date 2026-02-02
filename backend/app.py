import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

try:
    from backend.agents import build_agents
    from backend.database import init_db, list_published_packages, save_published_package
    from backend.models import CampaignRequest
    from backend.workflow import WorkflowControls, run_campaign_workflow
except ModuleNotFoundError:
    # Allow running via `python app.py` from the backend folder.
    ROOT = Path(__file__).resolve().parents[1]
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from backend.agents import build_agents
    from backend.database import init_db, list_published_packages, save_published_package
    from backend.models import CampaignRequest
    from backend.workflow import WorkflowControls, run_campaign_workflow

if sys.platform == "win32":
    # Must be set before any event loop is created to allow subprocess support on Windows.
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

load_dotenv(Path(__file__).resolve().parent / ".env")

ROOT = Path(__file__).resolve().parents[1]
UI_DIR = ROOT / "ui"

app = FastAPI(title="Marketing Campaign Multi-Agent")
app.mount("/ui", StaticFiles(directory=UI_DIR), name="ui")

init_db()


@app.get("/")
async def index():
    return FileResponse(UI_DIR / "index.html")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        agents = build_agents()
    except Exception as exc:
        await websocket.send_text(
            json.dumps(
                {
                    "type": "error",
                    "payload": {
                        "message": "Agent initialization failed. Check SDK installs and credentials.",
                        "details": str(exc),
                    },
                }
            )
        )
        await websocket.close(code=1011)
        return
    azure_config_message = (
        "Azure OpenAI config: "
        f"endpoint={os.getenv('AZURE_OPENAI_ENDPOINT','') or '<missing>'}, "
        f"deployment={os.getenv('AZURE_OPENAI_CHAT_DEPLOYMENT_NAME') or os.getenv('AZURE_OPENAI_DEPLOYMENT') or '<missing>'}, "
        f"api_version={os.getenv('AZURE_OPENAI_API_VERSION') or '2024-05-01-preview'}"
    )
    print(azure_config_message)
    await websocket.send_text(
        json.dumps(
            {
                "type": "system",
                "payload": {
                    "message": azure_config_message
                },
            }
        )
    )
    controls = WorkflowControls(
        feedback_queue=asyncio.Queue(),
        approval_queue=asyncio.Queue(),
        publish_queue=asyncio.Queue(),
    )
    workflow_task = None

    async def send_event(event_type: str, payload: dict):
        if event_type == "final_output":
            from datetime import datetime
            package_id = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
            name = f"Campaign {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            publish_package = payload.get("publish_package", "")
            save_published_package(package_id, name, created_at, publish_package)
            payload = {
                **payload,
                "id": package_id,
                "name": name,
                "time": created_at,
            }
        await websocket.send_text(json.dumps({"type": event_type, "payload": payload}))

    await send_event(
        "system",
        {
            "message": "Connected to marketing multi-agent workflow.",
        },
    )

    await send_event(
        "published_history",
        {
            "items": list_published_packages(),
        },
    )

    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            event_type = data.get("type")
            payload = data.get("payload", {})

            if event_type == "start_workflow":
                if workflow_task and not workflow_task.done():
                    workflow_task.cancel()
                request = CampaignRequest(**payload)
                workflow_task = asyncio.create_task(
                    run_campaign_workflow(agents, request, send_event, controls)
                )
            elif event_type == "human_feedback":
                await controls.feedback_queue.put(payload.get("message", ""))
            elif event_type == "human_approve":
                await controls.approval_queue.put(bool(payload.get("approved")))
            elif event_type == "cancel_workflow":
                if workflow_task and not workflow_task.done():
                    workflow_task.cancel()
                    await send_event("status", {"phase": "system", "message": "Workflow cancelled."})
            else:
                await send_event("error", {"message": f"Unknown event: {event_type}"})

    except WebSocketDisconnect:
        if workflow_task and not workflow_task.done():
            workflow_task.cancel()


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8008"))
    uvicorn.run("backend.app:app", host=host, port=port, loop="asyncio", reload=False)

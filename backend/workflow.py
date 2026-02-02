import asyncio
import json
import os
from dataclasses import dataclass
from typing import Callable, Dict, Optional

from agent_framework import SequentialBuilder
from agent_framework import WorkflowOutputEvent, WorkflowStatusEvent, WorkflowFailedEvent, WorkflowStartedEvent

from .models import CampaignRequest


@dataclass
class WorkflowControls:
    feedback_queue: asyncio.Queue
    approval_queue: asyncio.Queue
    publish_queue: asyncio.Queue


def _safe_json_parse(text: str) -> Optional[Dict]:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                return None
    return None


def _extract_latest(conversation, author_name: str) -> str:
    for msg in reversed(conversation):
        if getattr(msg, "author_name", None) == author_name and getattr(msg, "text", None):
            return msg.text
    for msg in reversed(conversation):
        if getattr(msg, "text", None):
            return msg.text
    return ""


async def run_campaign_workflow(
    agents,
    request: CampaignRequest,
    send_event: Callable[[str, Dict], asyncio.Future],
    controls: WorkflowControls,
):
    async def run_sequential(participants, prompt: str, phase: str, label: str):
        await send_event(
            "status",
            {"phase": phase, "message": f"{label} started. Awaiting response..."},
        )
        workflow = SequentialBuilder().participants(participants).build()
        outputs = []
        async for event in workflow.run_stream(prompt):
            if isinstance(event, WorkflowStartedEvent):
                await send_event("workflow_event", {"phase": phase, "event": "started"})
            elif isinstance(event, WorkflowStatusEvent):
                await send_event("workflow_event", {"phase": phase, "event": f"status:{event.state}"})
            elif isinstance(event, WorkflowFailedEvent):
                await send_event("workflow_event", {"phase": phase, "event": "failed", "details": str(event.details)})
            elif isinstance(event, WorkflowOutputEvent):
                outputs.append(event.data)
        conversation = outputs[-1] if outputs else []
        await send_event("status", {"phase": phase, "message": f"{label} completed."})
        return conversation

    async def run_writer_reviewer(prompt: str, loop_index: int):
        writer_conversation = await run_sequential(
            [agents.writer],
            prompt,
            "writer",
            f"Writer (loop {loop_index})",
        )
        writer_text = _extract_latest(writer_conversation, "Writer")
        await send_event("agent_message", {"agent": "Writer", "content": writer_text})

        reviewer_prompt = (
            "Review the draft for clarity, compliance, and brand safety. "
            "Respond with JSON only: {\"approved\": true/false, \"feedback\": \"...\", \"risk_notes\": \"...\"}.\n\n"
            f"Draft:\n{writer_text}"
        )
        reviewer_conversation = await run_sequential(
            [agents.reviewer],
            reviewer_prompt,
            "reviewer",
            f"Reviewer (loop {loop_index})",
        )
        reviewer_text = _extract_latest(reviewer_conversation, "Reviewer")
        return writer_text, reviewer_text

    await send_event("status", {"phase": "planner", "message": "Planning campaign strategy."})

    plan_prompt = (
        "Create a marketing campaign plan with: objectives, key message, channel mix, "
        "timeline, and KPIs. Use this context:\n"
        f"Brief: {request.brief}\n"
        f"Goal: {request.goal}\n"
        f"Audience: {request.audience}\n"
        f"Channels: {', '.join(request.channels)}\n"
        f"Tone: {request.tone}\n"
        f"Constraints: {request.brand_constraints}\n"
    )
    plan_conversation = await run_sequential([agents.planner], plan_prompt, "planner", "Planner")
    plan = _extract_latest(plan_conversation, "Planner")
    await send_event("agent_message", {"agent": "Planner", "content": plan})

    draft = ""
    reviewer_feedback = ""
    approved = False
    force_reject_first = os.getenv("FORCE_REVIEWER_REJECT_FIRST", "").lower() in ("1", "true", "yes")

    for loop_index in range(1, request.loop_limit + 1):
        writer_prompt = (
            "Write a campaign draft based on this plan and feedback. Provide: "
            "headline, key message, channel-specific copy, CTA, and disclaimers if needed.\n"
            f"Plan:\n{plan}\n\n"
        )
        if reviewer_feedback:
            writer_prompt += f"Reviewer feedback to address:\n{reviewer_feedback}\n"

        draft, review_response = await run_writer_reviewer(writer_prompt, loop_index)

        parsed = _safe_json_parse(review_response)
        if parsed:
            approved = bool(parsed.get("approved"))
            reviewer_feedback = parsed.get("feedback", "")
            risk_notes = parsed.get("risk_notes", "")
        else:
            approved = "approve" in review_response.lower() and "not" not in review_response.lower()
            reviewer_feedback = review_response
            risk_notes = ""

        forced_reject = False
        if force_reject_first and loop_index == 1 and approved:
            approved = False
            reviewer_feedback = "Demo mode: forcing an extra review loop for visibility."
            risk_notes = "Auto-flag to show loop behavior."
            forced_reject = True

        if forced_reject:
            review_response = f"{review_response}\n\n[Demo] Forced extra review loop."

        await send_event("agent_message", {"agent": "Reviewer", "content": review_response})

        await send_event(
            "review_decision",
            {
                "approved": approved,
                "feedback": reviewer_feedback,
                "risk_notes": risk_notes,
                "loop": loop_index,
                "forced": forced_reject,
            },
        )

        if approved:
            break

    if not approved:
        await send_event(
            "needs_human",
            {
                "message": "Writer and Reviewer could not align. Human input required.",
                "draft": draft,
                "feedback": reviewer_feedback,
            },
        )
        human_feedback = await controls.feedback_queue.get()
        await send_event("status", {"phase": "human", "message": "Human feedback received."})

        writer_prompt = (
            "Write a campaign draft based on this plan and feedback. Provide: "
            "headline, key message, channel-specific copy, CTA, and disclaimers if needed.\n"
            f"Plan:\n{plan}\n\n"
            f"Human feedback to incorporate:\n{human_feedback}\n"
        )
        if reviewer_feedback:
            writer_prompt += f"Previous reviewer feedback:\n{reviewer_feedback}\n"

        draft, review_response = await run_writer_reviewer(writer_prompt, request.loop_limit + 1)

    await send_event("status", {"phase": "publisher", "message": "Awaiting human approval."})
    await send_event(
        "needs_approval",
        {
            "message": "Review the final draft and approve to publish.",
            "draft": draft,
        },
    )
    approval = await controls.approval_queue.get()
    if not approval:
        await send_event("status", {"phase": "halted", "message": "Publishing halted by human."})
        return {"published": False, "draft": draft}

    await send_event("status", {"phase": "publisher", "message": "Publisher preparing release."})
    publish_prompt = (
        "Finalize the approved campaign into a publish-ready package: final copy, "
        "scheduling notes, and asset checklist.\n\n"
        f"Approved Draft:\n{draft}"
    )
    publish_conversation = await run_sequential([agents.publisher], publish_prompt, "publisher", "Publisher")
    publish_result = _extract_latest(publish_conversation, "Publisher")
    await send_event("agent_message", {"agent": "Publisher", "content": publish_result})

    await send_event(
        "final_output",
        {
            "draft": draft,
            "publish_package": publish_result,
        },
    )

    await send_event("published", {"status": "ready", "message": "Publish package ready."})
    return {"published": True, "draft": draft, "publish_package": publish_result}

from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel
from decimal import Decimal
import math
import uuid
import logging
import asyncio

from agents import DirectorAgent, ProducerAgent, EditorAgent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("Orchestrator")

app = FastAPI(
    title="Automated Multi-Agent Video Engine",
    description="Fully autonomous, free-tier architecture for generating 9:16 social media videos.",
    version="3.0.0"
)

class VideoRequest(BaseModel):
    topic: str

def run_agentic_pipeline(topic: str, job_id: str):
    """
    The main orchestrator loop coordinating the 3 Agents.
    Runs synchronously but handles asyncio internally for edge-tts.
    """
    logger.info(f"=== Starting Job {job_id} for topic: {topic} ===")

    # 1. Director Agent: Write Script
    director = DirectorAgent()
    script_data = director.generate_script(topic)
    logger.info(f"Script Generated: {script_data['title']}")

    # 2. Producer Agent: Gather Media
    producer = ProducerAgent()

    # Fetch Video
    bg_video_path = producer.fetch_background_video(script_data["search_query"], job_id)

    # Generate Audio (need new event loop since this is a background task)
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    audio_path = loop.run_until_complete(producer.generate_voiceover(script_data["voiceover_text"], job_id))

    # 3. Editor Agent: Render Video
    editor = EditorAgent()
    final_video_path = editor.render_video(script_data, audio_path, bg_video_path, job_id)

    logger.info(f"=== Job {job_id} Finished! Video available at {final_video_path} ===")


@app.post("/api/v1/video/generate", tags=["Video Generation"])
async def generate_video_endpoint(request: VideoRequest, background_tasks: BackgroundTasks):
    """
    Trigger the Multi-Agent video generation pipeline.
    Runs in the background to avoid HTTP timeouts.
    """
    job_id = str(uuid.uuid4())[:8]
    background_tasks.add_task(run_agentic_pipeline, request.topic, job_id)

    return {
        "status": "processing",
        "message": f"Multi-Agent pipeline triggered for '{request.topic}'",
        "job_id": job_id,
        "output_dir": "/app/output"
    }

@app.get("/health", tags=["Health"])
async def health_check():
    """
    Health check endpoint.
    """
    return {"status": "healthy", "version": "3.0.0"}

if __name__ == "__main__":
    import sys

    # Allow CLI execution for testing
    if len(sys.argv) > 1 and sys.argv[1] == "--cli":
        topic = "The hidden secrets of the deep ocean" if len(sys.argv) == 2 else sys.argv[2]
        job_id = "cli_test"
        run_agentic_pipeline(topic, job_id)
    else:
        import uvicorn
        uvicorn.run(app, host="0.0.0.0", port=8000)

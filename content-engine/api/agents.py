import os
import json
import logging
import requests
import uuid
from pathlib import Path
from dotenv import load_dotenv

import google.generativeai as genai
import edge_tts
from moviepy.editor import VideoFileClip, AudioFileClip, TextClip, CompositeVideoClip, concatenate_videoclips
from moviepy.config import change_settings

# Configure ImageMagick path for MoviePy
change_settings({"IMAGEMAGICK_BINARY": "convert"})

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("MultiAgentVideoEngine")

# Set up working directories
TEMP_DIR = Path("/app/temp_media")
OUTPUT_DIR = Path("/app/output")
TEMP_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


class DirectorAgent:
    """
    Responsible for generating the script, visual cues, and Pexels search keywords
    using Google Gemini API (or a mock if API key is missing).
    """
    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY")
        if self.api_key:
            genai.configure(api_key=self.api_key)
            self.model = genai.GenerativeModel('gemini-1.5-pro-latest')
            logger.info("DirectorAgent initialized with Gemini API.")
        else:
            self.model = None
            logger.warning("No GEMINI_API_KEY found. DirectorAgent will use mock data.")

    def generate_script(self, topic: str):
        prompt = f"""
        Act as a professional short-form video director (TikTok/Reels).
        Create a highly engaging script about: "{topic}".

        Output strictly in valid JSON format with the following structure:
        {{
            "title": "A catchy title",
            "search_query": "A 1-2 word visual keyword to search on Pexels (e.g., 'nature', 'technology', 'city')",
            "voiceover_text": "The exact script to be spoken. Keep it under 20 seconds. Make it punchy.",
            "captions": [
                {{"text": "First part of sentence", "duration": 2.0}},
                {{"text": "Second part of sentence", "duration": 3.0}}
            ]
        }}
        """

        if self.model:
            try:
                response = self.model.generate_content(prompt)
                # Quick hack to parse JSON block if wrapped in markdown
                content = response.text
                if "```json" in content:
                    content = content.split("```json")[1].split("```")[0].strip()
                return json.loads(content)
            except Exception as e:
                logger.error(f"Gemini API failed: {e}. Falling back to mock.")

        # Mock Data Fallback
        return {
            "title": f"Amazing facts about {topic}",
            "search_query": "abstract",
            "voiceover_text": f"Did you know about {topic}? It is absolutely mind-blowing how this changes everything we know! Subscribe for more.",
            "captions": [
                {"text": f"Did you know about {topic}?", "duration": 2.5},
                {"text": "It is absolutely mind-blowing...", "duration": 2.5},
                {"text": "How this changes everything!", "duration": 2.0},
                {"text": "Subscribe for more.", "duration": 2.0}
            ]
        }


class ProducerAgent:
    """
    Responsible for fetching free assets: Background videos from Pexels
    and TTS audio using edge-tts.
    """
    def __init__(self):
        self.pexels_key = os.getenv("PEXELS_API_KEY")
        if not self.pexels_key:
            logger.warning("No PEXELS_API_KEY found. Will use a hardcoded sample video if available, or fail gracefully.")

    async def generate_voiceover(self, text: str, job_id: str) -> str:
        """Generate high-quality TTS using edge-tts."""
        audio_path = str(TEMP_DIR / f"{job_id}_voice.mp3")
        logger.info(f"Generating TTS audio at {audio_path}...")
        # Using a popular, energetic voice
        communicate = edge_tts.Communicate(text, "en-US-ChristopherNeural")
        await communicate.save(audio_path)
        return audio_path

    def fetch_background_video(self, query: str, job_id: str) -> str:
        """Download a vertical video from Pexels."""
        video_path = str(TEMP_DIR / f"{job_id}_bg.mp4")

        if not self.pexels_key:
            logger.error("Skipping Pexels download due to missing API key. Generating a blank color clip instead.")
            return None # Editor will handle None by creating a blank clip

        url = f"https://api.pexels.com/videos/search?query={query}&orientation=portrait&per_page=1"
        headers = {"Authorization": self.pexels_key}

        try:
            logger.info(f"Searching Pexels for: {query}")
            response = requests.get(url, headers=headers)
            response.raise_for_status()
            data = response.json()

            if not data.get("videos"):
                logger.warning("No videos found on Pexels. Editor will use fallback.")
                return None

            # Grab the best HD vertical link
            video_files = data["videos"][0]["video_files"]
            best_link = sorted(video_files, key=lambda x: x["width"] * x["height"], reverse=True)[0]["link"]

            logger.info(f"Downloading video from {best_link}")
            vid_data = requests.get(best_link).content
            with open(video_path, 'wb') as f:
                f.write(vid_data)
            return video_path

        except Exception as e:
            logger.error(f"Pexels fetch failed: {e}")
            return None


class EditorAgent:
    """
    Responsible for stitching video, audio, and generating TextClips (Karaoke style).
    """
    def __init__(self):
        pass

    def render_video(self, script_data: dict, audio_path: str, bg_video_path: str, job_id: str) -> str:
        """Combine assets into a final 9:16 vertical video using MoviePy."""
        output_path = str(OUTPUT_DIR / f"{job_id}_final.mp4")
        logger.info(f"EditorAgent starting render: {output_path}")

        try:
            # 1. Load Audio
            audio = AudioFileClip(audio_path)
            duration = audio.duration

            # 2. Load or Create Background
            if bg_video_path and os.path.exists(bg_video_path):
                bg_clip = VideoFileClip(bg_video_path)
                # Ensure it's long enough, loop if necessary
                if bg_clip.duration < duration:
                    from moviepy.video.fx.all import loop
                    bg_clip = loop(bg_clip, duration=duration)
                else:
                    bg_clip = bg_clip.subclip(0, duration)

                # Resize and crop to 9:16 (1080x1920) TikTok format
                w, h = bg_clip.size
                target_ratio = 1080 / 1920
                current_ratio = w / h

                if current_ratio > target_ratio:
                    # Video is too wide, crop width
                    new_w = int(h * target_ratio)
                    x_center = w / 2
                    bg_clip = bg_clip.crop(x1=x_center - new_w/2, y1=0, x2=x_center + new_w/2, y2=h)

                bg_clip = bg_clip.resize((1080, 1920))
            else:
                from moviepy.editor import ColorClip
                bg_clip = ColorClip(size=(1080, 1920), color=(20, 20, 20), duration=duration)

            bg_clip = bg_clip.set_audio(audio)

            # 3. Generate Captions (Karaoke Style)
            caption_clips = []
            current_time = 0.0

            for cap in script_data["captions"]:
                cap_text = cap["text"]
                cap_dur = cap["duration"]

                # Ensure we don't exceed total audio duration
                if current_time + cap_dur > duration:
                    cap_dur = duration - current_time
                    if cap_dur <= 0:
                        break

                # Create TextClip using ImageMagick
                txt_clip = TextClip(
                    cap_text,
                    fontsize=80,
                    color='white',
                    font='DejaVu-Sans-Bold',
                    stroke_color='black',
                    stroke_width=3,
                    method='caption',
                    size=(900, None) # Wrap text
                )

                txt_clip = txt_clip.set_position(('center', 'center')).set_start(current_time).set_duration(cap_dur)
                caption_clips.append(txt_clip)
                current_time += cap_dur

            # 4. Composite and Render
            final_clip = CompositeVideoClip([bg_clip] + caption_clips)

            logger.info("Writing videofile...")
            final_clip.write_videofile(
                output_path,
                fps=30,
                codec="libx264",
                audio_codec="aac",
                preset="ultrafast",
                logger=None # Disable TQDM progress bar for cleaner logs
            )

            logger.info(f"Render complete! Saved to {output_path}")
            return output_path

        except Exception as e:
            logger.error(f"Render failed: {e}")
            raise
        finally:
            # Cleanup temp files if needed, skipping for debug observability
            pass

FROM python:3.14-slim

# Set environment variables to non-interactive and ensure output is unbuffered
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install system dependencies: FFmpeg and dependencies for Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wget \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browsers (needed for Google Vids automation / Remotion)
RUN pip install playwright && playwright install --with-deps chromium

# Copy application code
COPY . .

# Expose the API port
EXPOSE 8000

# Start the FastAPI application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

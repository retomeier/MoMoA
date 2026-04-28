FROM python:3.11-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Tell ImageMagick where to find its config so MoviePy text works
    MAGICK_CONFIGURE_PATH=/etc/ImageMagick-6

WORKDIR /app

# Install system dependencies: FFmpeg, ImageMagick, Ghostscript (for fonts/text rendering), fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    imagemagick \
    ghostscript \
    fonts-liberation \
    fonts-dejavu \
    wget \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Fix ImageMagick policy to allow TextClip generation in MoviePy
# By default, some ImageMagick setups disable reading/writing PDFs or using ghostscript fonts for security.
RUN sed -i 's/<policy domain="path" rights="none" pattern="@\*"/<!-- <policy domain="path" rights="none" pattern="@\*" \/-->/g' /etc/ImageMagick-6/policy.xml || true

# Install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Create necessary directories for media processing
RUN mkdir -p /app/temp_media /app/output

# Copy application code
COPY . .

# Expose the API port
EXPOSE 8000

# Start the FastAPI application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

# Stingyclaw Agent Container
# Runs the OpenRouter-based agent loop in an isolated Linux container

FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ripgrep \
    python3 \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser (headless browser CLI for AI agents)
# Chromium is stored in a shared path so the node user can access it
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright
RUN npm install -g agent-browser && \
    agent-browser install --with-deps && \
    chmod -R a+rx /usr/local/share/playwright

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies (--legacy-peer-deps: openai has optional zod@3 peer dep, we use zod@4)
RUN npm install --legacy-peer-deps

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Pre-download local embedding model (Xenova/all-MiniLM-L6-v2, ~23MB quantized)
# Stored in /home/node/.stingyclaw/transformers — baked into image, no cold start
RUN mkdir -p /home/node/.stingyclaw/transformers && \
    node download-embed-model.mjs && \
    chmod -R a+r /home/node/.stingyclaw/transformers

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user for security
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]

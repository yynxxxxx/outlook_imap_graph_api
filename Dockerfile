FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci

COPY . .

RUN python3 -m venv /opt/proton-venv \
  && /opt/proton-venv/bin/pip install --no-cache-dir -r requirements.txt \
  && npm run build \
  && npm prune --omit=dev

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV PYTHON_BIN=/opt/proton-venv/bin/python

EXPOSE 3000

CMD ["npm", "start"]

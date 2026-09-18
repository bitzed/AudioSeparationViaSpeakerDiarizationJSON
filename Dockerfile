# AudioSeparator — Cloud Run image.
# ffmpeg is required at runtime for the muting step.
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# Cloud Run sets PORT; default for local docker runs.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]

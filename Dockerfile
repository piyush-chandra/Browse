# Browse on a persistent Node host (Railway / Render / Fly / any VPS).
# Vercel/Netlify serverless CANNOT run this app (no custom server,
# no WebSocket upgrades, no Chrome). Use this image instead.
FROM node:20-bookworm-slim

# Google Chrome (for /remote real-browser sessions) + minimal runtime deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget gnupg \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends \
    google-chrome-stable \
  && rm -rf /var/lib/apt/lists/* \
  && google-chrome --version

ENV CHROME_PATH=/usr/bin/google-chrome

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

# Must listen on all interfaces inside a container.
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]

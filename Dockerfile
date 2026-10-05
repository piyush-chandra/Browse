# Browse on a persistent Node host (Railway / Render / Fly / any VPS).
# (Vercel uses Dockerfile.vercel instead. Netlify serverless cannot run
# this app: no custom server, no WebSocket upgrades, no Chrome.)
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
# --ignore-scripts: our postinstall (scripts/setup-proxy-assets.mjs) runs at
# the prebuild step instead — scripts/ isn't COPYed into the image yet here.
# Full install (no --omit=dev): `next build` needs devDependencies
# (typescript, tailwindcss); devDeps are pruned after the build.
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build \
  && npm prune --omit=dev

# Must listen on all interfaces inside a container.
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]

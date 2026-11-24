# The Red Queen arena service: relay, demo attack, judge top-up and bots behind one port (gateway.mjs).
FROM node:22-slim
WORKDIR /app
# the workspace manifests (contracts and web only as manifests, so the lockfile stays in step)
COPY package.json package-lock.json ./
COPY contracts/package.json contracts/package.json
COPY web/package.json web/package.json
COPY sdk sdk
COPY relay relay
COPY bots bots
COPY deployments deployments
RUN npm ci -w sdk -w relay -w bots --include-workspace-root=false --no-audit --no-fund
COPY gateway.mjs gateway.mjs
# Hugging Face runs containers as user 1000; the bots keep a little state in bots/.state
RUN mkdir -p bots/.state && chown -R 1000:1000 /app
USER 1000
ENV CHAIN_ID=84532 RPC_URL=https://sepolia.base.org PORT=7860
EXPOSE 7860
CMD ["node", "gateway.mjs"]

# Relay image for `agent-memory relay`. The key comes only from AGENT_MEMORY_RELAY_KEY at run time:
# never bake it into the image or pass it as a build argument.
FROM node:22-slim
LABEL org.opencontainers.image.source="https://github.com/Tacuchi/agent-memory" \
      org.opencontainers.image.description="agent-memory relay: pairs two installations and forwards ciphertext only" \
      org.opencontainers.image.licenses="MIT"

# Same published version as the machines that use the relay.
ARG AGENT_MEMORY_VERSION=0.6.1
RUN npm install -g --omit=dev "@tacuchi/agent-memory@${AGENT_MEMORY_VERSION}" && npm cache clean --force

USER node
EXPOSE 8787

# Healthy means "answers 401 without the key": the check never needs the key.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/').then((r) => process.exit(r.status === 401 ? 0 : 1), () => process.exit(1))"

# Plain HTTP inside the container: publish it only behind an HTTPS reverse proxy.
CMD ["agent-memory", "relay", "--host", "0.0.0.0", "--puerto", "8787"]

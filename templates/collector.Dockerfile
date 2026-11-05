# A self-contained trusted tool image, built from shipped files and a frozen runtime closure.
# The supervisor stages this context without the user's workspace, credentials or source mounts.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY node_modules ./node_modules
COPY dist ./dist
COPY examples ./examples
USER 10001:10001
CMD ["node", "-e", "setInterval(() => {}, 30000)"]

FROM node:22.23.0-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save tsx@4
COPY src ./src
COPY demo ./demo
ENV SH_DATA_DIR=/data
CMD ["npx", "tsx", "src/server.ts"]

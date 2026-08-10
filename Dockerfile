FROM node:22-alpine

WORKDIR /app

# Copy package files first for cached dependencies
COPY package*.json ./

# Install dependencies deterministically
RUN npm ci --omit=dev || npm install

# Copy application source code
COPY . .

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
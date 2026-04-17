FROM node:24-alpine

WORKDIR /app

# Copy manifests first for layer caching
COPY package*.json ./

# Install production deps only
RUN npm ci --only=production

# Copy application source
COPY . .

EXPOSE 3000

CMD ["node", "src/index.js"]

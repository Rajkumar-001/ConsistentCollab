FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Expose ports for both instances
EXPOSE 1234 1235

# Start the server
CMD ["node", "src/server.js"]

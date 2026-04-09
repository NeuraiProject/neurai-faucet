FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY . .

# Build the project
RUN npm run build

# Final production image
FROM node:22-alpine

WORKDIR /app

# Copy production dependencies and built files
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Set environment variables for the production server
ENV HOST=0.0.0.0
ENV PORT=4321
ENV NODE_ENV=production

# Astro's default port for the server
EXPOSE 4321

# Run the built server
CMD ["node", "./dist/server/entry.mjs"]

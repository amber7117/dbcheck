# Use official Node.js LTS image
FROM node:20-slim

# Install Chromium dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
  wget \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libatspi2.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# Set workdir
WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install deps
RUN npm install

# Copy rest of code
COPY . .

# Expose (Cloud Run will assign a random port, but not used since Telegram calls webhook)
ENV PORT=8080

# Start bot
CMD ["node", "bot.js"]

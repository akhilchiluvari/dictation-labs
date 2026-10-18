FROM node:22.14.0-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm test && npm run check && npm run build

EXPOSE 1420
CMD ["npm", "run", "dev"]

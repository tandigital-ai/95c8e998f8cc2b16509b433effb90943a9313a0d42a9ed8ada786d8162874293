# Proxy Node 0 dependency + file tĩnh. Chạy: docker build -t ai-architect . && docker run -p 3000:3000 --env-file server/.env ai-architect
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY docs ./docs
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
# Trong container HOST=0.0.0.0 ⇒ BẮT BUỘC đặt ACCESS_TOKEN (proxy tự từ chối khởi động nếu thiếu).
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]

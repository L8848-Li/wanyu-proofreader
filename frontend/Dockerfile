FROM node:26-alpine AS dependencies

WORKDIR /app

COPY package*.json ./
RUN npm ci

FROM dependencies AS dev

COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM dependencies AS build

COPY . .
RUN NODE_OPTIONS=--max-old-space-size=768 npm run build

FROM nginx:1.31-alpine

# Refresh inherited XML libraries for CVE-2026-87636, CVE-2026-9947 and CVE-2026-11979.
RUN apk add --no-cache --upgrade 'libxslt>=1.1.43-r4' 'libxml2>=2.13.9-r5'

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/pocketbase-admin-disabled.conf /opt/fangji/nginx/pocketbase-admin-disabled.conf
COPY nginx/pocketbase-admin-enabled.conf /opt/fangji/nginx/pocketbase-admin-enabled.conf
COPY docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
RUN mkdir -p /etc/nginx/snippets \
  && cp /opt/fangji/nginx/pocketbase-admin-disabled.conf /etc/nginx/snippets/pocketbase-admin.conf \
  && : > /etc/nginx/snippets/trusted-proxies.conf \
  && chmod +x /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build /app/dist /usr/share/nginx/html

# Runtime configuration is intentionally writable only by the application user.
RUN sed -i 's@/var/run/nginx.pid@/tmp/nginx.pid@; s@/run/nginx.pid@/tmp/nginx.pid@; /^user /d' /etc/nginx/nginx.conf \
  && grep -Eq '^pid[[:space:]]+/tmp/nginx.pid;' /etc/nginx/nginx.conf \
  && chown -R nginx:nginx /etc/nginx/conf.d /etc/nginx/snippets /var/cache/nginx /usr/share/nginx/html
USER nginx
EXPOSE 8080

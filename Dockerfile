FROM nginxinc/nginx-unprivileged:alpine
# Copy only static web assets into the NGINX HTML folder (runs as non-root UID 101)
COPY --chown=nginx:nginx index.html main.js demo.png /usr/share/nginx/html/
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]

FROM nginx:alpine
# Copy all static assets into the default NGINX HTML folder
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

// Chỉ dùng trong sandbox để kiểm thử. Trên máy cá nhân chạy: npm start (mặc định 127.0.0.1).
module.exports = {
  apps: [{
    name: 'webapp',
    script: 'server/index.js',
    env: { HOST: '0.0.0.0', PORT: 3000, ALLOW_INSECURE_PUBLIC: '1', LOG_REQUESTS: '1' },
    watch: false, instances: 1, exec_mode: 'fork'
  }]
};

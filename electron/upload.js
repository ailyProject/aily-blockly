const { spawn } = require('child_process');
const path = require('path');

// 获取参数: node upload.js <command> <arg1> <arg2> ...
// 注意：参数可能包含空格，需要正确处理
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Error: No command provided to upload.js');
  process.exit(1);
}

const command = args[0];
const commandArgs = args.slice(1);

console.log(`[Upload Script] Starting: ${command}`);
// console.log(`[Upload Script] Args: ${JSON.stringify(commandArgs)}`);

const child = spawn(command, commandArgs, {
  stdio: 'inherit', // 直接继承 stdio，这样输出会直接流向父进程
  shell: false // 不使用 shell，避免信号传递问题
});

child.on('error', (err) => {
  console.error(`[Upload Script] Failed to start subprocess: ${err.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  console.log(`[Upload Script] Process exited with code ${code}`);
  process.exit(code);
});

// 处理终止信号
const killChild = (signal) => {
  if (child) {
    console.log(`[Upload Script] Received ${signal}, killing child process...`);
    child.kill(signal); 
  }
  process.exit();
};

process.on('SIGTERM', () => killChild('SIGTERM'));
process.on('SIGINT', () => killChild('SIGINT'));

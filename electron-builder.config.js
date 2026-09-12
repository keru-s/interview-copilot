'use strict';

// electron-builder 配置。本地开发机（M 系列）用 `npm run dist:mac:local` 只打 arm64；
// CI 的 Release 工作流不带该环境变量，仍构建完整的 x64 + arm64 矩阵。
const macArch = process.env.MAC_ARM64_ONLY === '1' ? ['arm64'] : ['x64', 'arm64'];

module.exports = {
  appId: 'com.interview.copilot',
  productName: 'Real Time Interview Copilot',
  directories: {
    output: 'dist',
  },
  files: ['src/**/*', 'package.json'],
  mac: {
    category: 'public.app-category.productivity',
    target: [
      {
        target: 'dmg',
        arch: macArch,
      },
    ],
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Real Time Interview Copilot transcribes your microphone (the candidate) in real time.',
      NSScreenCaptureUsageDescription:
        'Real Time Interview Copilot captures system audio (the interviewer) via screen-capture loopback.',
    },
  },
  win: {
    target: ['nsis'],
  },
  linux: {
    target: ['AppImage'],
    category: 'Utility',
  },
};

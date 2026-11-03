// 导入类型：在 main.ts 里 Cmd/Ctrl+B 应当跳到这里
import type { User } from './models/user'

// 工厂函数：从调用处跳转，应当落到这个函数定义
export function getUser(name: string): User {
  return {
    id: Date.now(),
    name,
    email: `${name}@example.com`,
  }
}

// 带默认参数的方法，用来演示参数名与返回值的悬浮提示
export function rename(user: User, suffix = '_v2'): User {
  return { ...user, name: user.name + suffix }
}

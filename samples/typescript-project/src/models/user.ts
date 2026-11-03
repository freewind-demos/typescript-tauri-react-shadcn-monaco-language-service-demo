// 一个最普通的领域类型：跨文件跳转的目标之一
export interface User {
  id: number
  name: string
  email: string
}

// 角色枚举，用来演示枚举成员的补全
export type Role = 'admin' | 'guest'

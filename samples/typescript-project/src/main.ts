import { getUser, rename } from './api'

// 把光标放在 user. 后面按 Ctrl+Space，补全应当给出 id / name / email
const user = getUser('freewind')
console.log(user.name)

// 把光标放在 rename 上按 Cmd/Ctrl+B，应当跳到 api.ts 里的定义
const renamed = rename(user)
console.log(renamed.email)

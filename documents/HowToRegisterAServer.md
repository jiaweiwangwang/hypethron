# 注册一个新服务器

服务器框架采用 ![](https://img.shields.io/badge/koa-2.7-black.svg) ，支持多端口和HTTP及HTTPS，要注册、修改一个服务器的配置，您需要在 `/server/` 目录中，编辑【server-configure.js】文件，其中各字段意义如下:

字段|类型|意义|例值
:-:|:-:|:-:|:-:
port | int |服务器访问端口 | 3000
enableSLL | boolean |是否启用HTTPS(需要同时配置sslOptions) | false
sslOptions | object |SSL相关证书的配置 | (详见下文)

全局常量配置：
字段|类型|意义|例值
:-:|:-:|:-:|:-:
SKIP_HYPETHRON_INTRO_PAGE | boolean | 跳过院庭介绍页 | false
STATIC_DIRECTORY | string | 静态资源地址 | '../build'

---

```
// key-name will be treat as server-name, and register into server-map
def: {
        port: 3000, // Server port
        enableSLL: false, // Wanna to start a ssl http-server?
        sslOptions: { // Only required when $enableSLL is true
            key: null, // Your private-key URL
            cert: null  // Your ssl-certificate URL
        }
    },
	......
```
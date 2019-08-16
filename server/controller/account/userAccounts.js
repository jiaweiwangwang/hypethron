const {SERVER_PRIVATE_KEY, JWT_OPTIONS, SERVER_SALT} = require('../../server-configure.js');
const {hmac} = require('../../util/crypto-hash-tool.js');
const jwt = require('jsonwebtoken'); // @See https://www.npmjs.com/package/jsonwebtoken
const {jwtVerify, isJwtError} = require('../../util/tools.js');


/***
 * @Router `ctx.params.{uid}` 为用户的统一标识符，是一个大于1的整数；部分动词只对特殊的UID进行响应。
 */


/**
 * RESTful 用户查询，返回用户的账户信息，对权限有要求。当uid=0时通过过滤模式筛选所有符合要求的人信息
 * @params { uid: $Int }
 * When `ctx.params.{uid}` = 0:
 *  @input { filter: $Values }
 *    => filter contains :
 *      page: $int, // 当前页(必填)；从1起
 *      max: $int, // 每页最大数据量(必填)；最大为50
 *      // 下面两项为可选项
 *      username: $String, // 用户的 username 或 email 或 phone 或openid (支持模糊检索)
 *      authority: $int, // 目标用户权限
 * Else:
 *  @input { / }
 * @output { result:$Array }
 */
async function GET_userAccounts(ctx, next) {
  let mysql = ctx.global.mysqlPoolDM;
  let AUTH = ctx.AUTH;

  let uid = parseInt(ctx.params.uid) || 0;

  ctx.assert(uid >= 0, 404, '@url-params:uid should be positive.');

  let token = ctx.header.authorization;

  ctx.assert(token, 401);

  let decode = await jwtVerify(token).catch(err => {
    throw err;
  });

  ctx.assert(
    (decode.authority & (AUTH.USER_DATA_ANALYSIS | AUTH.ADMIN_GROUP)) > 0, 403,
    {detail: "只有管理组和用户数据分析师才能调取这个接口."}
  );

  if (uid > 0) { // 精确筛选模式
    let res = await mysql.query(
      {sql: 'SELECT * FROM user_account WHERE uid=?;', timeout: 10000}, [uid]
    ).catch(err => {
      throw err;
    });

    ctx.body = {
      result: res.result
    };
  } else {
    let filter = ctx.request.query;

    ctx.assert(filter.page && filter.max, 400, "@params:page and @params:max is required.");
    ctx.assert(filter.page > 0, 400, "@params:page should be positive.");
    ctx.assert(filter.max <= 50, 400, "@params:max should be less then 50.");

    let values = [];
    let sql = '';
    if (filter.username) {
      sql += ' AND (a.username LIKE ? or a.openid LIKE ? or b.email LIKE ? or b.phone LIKE ?)';
      for (let i = 0; i < 4; i++) values.push(`%${filter.username}%`);
    }

    if (filter.authority) {
      values.push(filter.authority);
      sql += ' AND a.authority = ? ';
    }

    // ctx.assert(values.length > 0, 400, "@params:username or @params:authority should not be all undefined.");

    let res = await mysql.query(
      {
        sql: `SELECT a.* FROM user_account AS a LEFT JOIN user_profile AS b ON a.uid=b.uid WHERE true ${sql};`,
        timeout: 10000
      }, values
    ).catch(err => {
      throw err;
    });

    let totalHit = res.result.length;
    // filter.max = Math.min(parseInt(filter.max) || 0, 50); // 非数字值将被转化为0
    // filter.page = parseInt(filter.page) || 0;

    ctx.body = { // 返回结果
      result: res.result.slice(filter.max * (filter.page - 1), Math.min(totalHit, filter.max * filter.page))
    };
  }

  return next();
}

/**
 * RESTful 注册接口，返回一个注册是否成功的标志即服务器签发的Token，并尝试写入session-cookies。
 * When do POST, response on ".../userAccounts/0"
 * @need-session { captcha: $String, captchaForBind: $String }
 * @input { username: $String, password: $String, salt: $String, captcha: $String }
 * @set-cookies { @Authorization: authorizationToken }
 * @output { token: $String }
 */
async function POST_userAccounts(ctx, next) {
  let mysql = ctx.global.mysqlPoolDM;
  let logger = ctx.global.logger;

  let username = ctx.request.body.username; // 用以登录的用户名
  let password = ctx.request.body.password; // 经过前端慢计算的哈希密码
  let salt = ctx.request.body.salt; // 慢计算用盐

  let email = ctx.session.emailForBind; // 绑定的邮箱名(此时默认email已从邮箱绑定接口注册到session中)
  let captchaServer = '' + ctx.session.captchaForBind; // 注册时的验证码(服务端) 应为6位字符长(强制转字符串)
  let captchaClient = '' + ctx.request.body.captcha; // 注册时的验证码(客户端)

  ctx.assert(username, 400, `@params:username is required.`);
  ctx.assert(password, 400, `@params:password is required.`);
  ctx.assert(salt, 400, `@params:salt is required.`);
  ctx.assert(email, 400, `@session-params:email is required. Try to regenerate it.`);
  ctx.assert(captchaServer, 400, `@session-params:captchaServer is required. Try to regenerate it.`);
  ctx.assert(captchaClient, 400, `@params:captchaClient is required.`);

  // 不区分验证码的大小写(尽管这里应该是6位数字)
  ctx.assert(captchaServer.toUpperCase() === captchaClient.toUpperCase(), 409, 'Captcha doesn\'t match.');

  let connection = await mysql.beginTransaction().catch(err => {// 获取一个事务实例
    throw err;
  });

  try { // 开始进行事务

    let usersCount = await connection.query( // 事务回滚会导致AUTO_INCREMENT产生间隙，这里手动对UID进行修正
      {                                      // 尽管这样可能会导致并发注册请求的某些问题
        sql: 'SELECT COUNT(*) as total, MAX(uid) as maxUid FROM user_account',
        timeout: 10000
      }
    ).catch(err => {
        throw err;
      }
    );

    let nextUid = Math.max(usersCount.result[0].total, usersCount.result[0].maxUid) + 1; // 中间因DEL等造成的间隙直接放弃

    await connection.query( // 插入用户账户表
      {sql: 'INSERT INTO user_account(uid, username, password, salt) values (?, ?, ?, ?);', timeout: 10000},
      [nextUid, username, hmac(SERVER_SALT, password, {alg: "md5", repeat: 1}), salt]
    ).catch(err => {
        throw err;
      }
    );

    let res = await connection.query( // 获取刚刚插入的用户的各项信息
      {sql: 'SELECT * FROM user_account WHERE username=?;', timeout: 10000}, [username]
    ).catch(err => {
        throw err;
      }
    );

    if (res.result.length > 0) {
      await connection.query( // 创建级联表:用户信息表
        {sql: 'INSERT INTO user_profile(uid, nickname, email) values (?, ?, ?);', timeout: 10000},
        [res.result[0].uid, `${username}(${res.result[0].uid})`, email]
      ).catch(err => {
        throw err;
      });

      await connection.query( // 创建级联表:用户隐私表
        {sql: 'INSERT INTO user_privacy(uid) values (?);', timeout: 10000}, [res.result[0].uid]
      ).catch(err => {
        throw err;
      });

      await connection.commit().catch(err => {
        throw err
      });

      logger.info(`User ${res.result[0].uid} register success, his/her email is [${email}].`);

      let authorizationToken = jwt.sign({
        uid: res.result[0].uid,
        authority: res.result[0].authority
      }, SERVER_PRIVATE_KEY, JWT_OPTIONS);

      ctx.body = { // 注册成功，签发Token {uid, authority}
        token: authorizationToken
      };

      // 尝试写入cookies
      try {
        ctx.cookies.set('Authorization', authorizationToken, {maxAge: 7 * 24 * 60 * 60 * 1000/*7 days*/, signed: true});
      } catch (e) {
        /*ignore err*/
      }

      // 清空session
      ctx.session.emailForBind = null;
      ctx.session.captchaForBind = null;
    } else {
      ctx.throw(409);
    }
  } catch (err) {
    await connection.rollback() // 发生错误则事务回撤
      .catch(e => {
        /* ignore */
      })
      .finally(() => {
        ctx.throw(500, err);
      });
  } finally {
    connection.release();
  }

  return next();
}

/**
 * RESTful 部分更改用户账户信息表的接口，对权限有要求。返回操作是否成功的标志。
 * @params { uid: $String }
 * @input { updateData: $Object => '{ username:$String, openid:$String, password:$String, salt:$String, authority:$Integer }'}
 * @output { success: $Boolean }
 */
async function PATCH_userAccounts(ctx, next) {
  let mysql = ctx.global.mysqlPoolDM;
  let AUTH = ctx.AUTH;

  let uid = parseInt(ctx.params.uid) || 0; // 保证是个整数值

  ctx.assert(uid > 0, 400, '@params:uid should be positive.');

  let token = ctx.header.authorization;

  ctx.assert(token, 401);

  let decode = await jwtVerify(token).catch(err => {
    throw err;
  });

  ctx.assert(
    (decode.authority & AUTH.ADMIN_GROUP) > 0 || decode.uid === uid, 403,
    {detail: "只有管理组或本人才能调取这个接口."}
  );

  let updateData = ctx.request.body.updateData;

  ctx.assert(updateData, 400, "@params:updateData is required.");

  let values = [];
  let sql = '';
  let map = {
    " username=?": (decode.authority & AUTH.SUPER_ADMIN) > 0 ? updateData.username : undefined, // 只有超管才能改用户名
    " openid = ?,": updateData.openid,
    " password = ?,": updateData.password ? hmac(SERVER_SALT, updateData.password, {alg: "md5", repeat: 1}) : undefined,
    " salt = ?,": updateData.salt,
    " authority = ?,": (decode.authority & AUTH.SUPER_ADMIN) > 0 ? updateData.authority : undefined, // 只有超管才能改权限
  };

  for (let i in map) {
    if (map[i] !== undefined) { // 非空的值就入栈
      sql += i;
      values.push(map[i]);
    }
  }

  ctx.assert(values.length > 0, 400, "@params:updateData is an empty object.");

  sql = sql.replace(/,$/, ""); // 移除末尾的逗号
  values.push(uid);

  let res = await mysql.query({
    sql: `UPDATE user_account SET ${sql} WHERE uid=?;`,
    timeout: 10000
  }, values).catch(err => {
    throw err
  });

  ctx.body = {
    success: res.result.affectedRows > 0
  };

  return next();
}

/**
 * RESTful 删除用户账户信息表(及级联表)的接口，对权限有要求。返回操作是否成功的标志。
 * @params { uid: $Int }
 * @input { / }
 * @output { success: $Boolean }
 */
async function DELETE_userAccounts(ctx, next) {
  let mysql = ctx.global.mysqlPoolDM;
  let AUTH = ctx.AUTH;
  let logger = ctx.global.logger;

  let uid = parseInt(ctx.params.uid) || 0;

  ctx.assert(ctx.params.uid > 0, 404, '@url-params:uid should be positive.');

  let token = ctx.header.authorization;

  ctx.assert(token, 401);

  let decode = await jwtVerify(token).catch(err => {
    throw err;
  });

  ctx.assert((decode.authority & AUTH.ADMIN_GROUP) > 0, 403, {detail: "只有管理组才能调取这个接口."});

  let connection = await mysql.beginTransaction().catch(err => {// 获取一个事务实例
    throw err;
  });

  try {
    // 删除所有关联表
    let tables = ['user_privacy', 'user_profile', 'user_account'];
    for (let table of tables) {
      await mysql.query(`DELETE FROM ${table} WHERE uid=?`, [uid]).catch(err => {
        throw err;
      })
    }

    await connection.commit().catch(err => { // 尝试确认更改
      throw err
    });

    logger.info(`user-account:[${uid}] has been delete by admin:[${decode.uid}]`); // 标记到日志里

    ctx.body = { // 移除成功
      success: true
    };

  } catch (err) {
    await connection.rollback() // 发生错误则事务回撤
      .catch(e => {
        /* ignore */
      })
      .finally(() => {
        ctx.throw(500, err);
      });
  } finally {
    connection.release();
  }
  return next();
}

module.exports = {
  GET_userAccounts,
  POST_userAccounts,
  PATCH_userAccounts,
  DELETE_userAccounts
};
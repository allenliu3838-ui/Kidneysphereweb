-- ============================================================
-- migration_20260328_grant_glom_batch.sql
--
-- 批量为肾小球病培训项目学员授予 project_access 权益 + 项目报名
-- 共 ~180 个邮箱，跳过系统中找不到的账号并在最后汇总。
-- ============================================================

do $$
declare
  _glom_specialty_id uuid;
  _glom_project_id   uuid;
  _glom_product_id   uuid;
  _email             text;
  _uid               uuid;
  _granted           int := 0;
  _skipped           int := 0;
  _emails            text[] := array[
    '750480511@qq.com',
    '957890594@qq.com',
    '13897487786@163.com',
    '18832357889@163.com',
    'baoshumin912@126.com',
    '121680005@qq.com',
    '631789246@qq.com',
    '664989031@qq.com',
    '18712905512@163.com',
    '717402900@qq.com',
    '280046819@qq.com',
    '1552413759@qq.com',
    '18535536987@163.com',
    '2016439436@qq.com',
    'smallguai@sina.com',
    '18105152682@163.com',
    'dr.xiaoan@qq.com',
    '47828570@qq.com',
    'shang9401@qq.com',
    '760551674@qq.com',
    '913489401@qq.com',
    'peiyaogege@163.com',
    'cleo_na@hotmail.com',
    '807382715@qq.com',
    'yueying88@qq.com',
    '276799917@qq.com',
    '464475667@qq.com',
    '2545966068@qq.com',
    'm19924740118@163.com',
    'Zhxiaoyi050699@outlook.com',
    '441973515@qq.com',
    'sgqzsf@126.com',
    '13835603531@163.com',
    'su821002@163.com',
    'lmnavy@163.com',
    '2661899335@qq.com',
    '18870825489@163.com',
    '1520102709@qq.com',
    'zyy9221@126.com',
    '549567015@qq.com',
    '1103397925@qq.com',
    'm18023689150@163.com',
    '619786365@qq.com',
    'plseylili@163.com',
    '3143165388@qq.com',
    '605912394@qq.com',
    '452027328@qq.com',
    'clb10010519@163.com',
    '13677653886@163.com',
    '3278935011@qq.com',
    '543845976@qq.com',
    'bucmchenpenghui@163.com',
    'fair05119@163.com',
    '747728848@qq.com',
    'chenni08@163.com',
    'M15186227099_1@163.com',
    'wszlnz@163.com',
    '412017503@qq.com',
    '53057934@qq.com',
    '545089818@qq.com',
    '271849692@qq.com',
    '1129192926@qq.com',
    '1020642868@qq.com',
    'cxfjiayou0626@sina.cn',
    '14751294787@163.com',
    '422601904@qq.com',
    'L3588725@163.com',
    '693921929@qq.com',
    'lmchen526@126.com',
    'yjsgss@126.com',
    'singer_zh@sina.com',
    '375732774@qq.com',
    'kathy_qing@163.com',
    '1203508011@qq.com',
    '61082521@qq.com',
    '946825755@qq.com',
    'fanxl8296@126.com',
    '2499262578@qq.com',
    'jydou2016@163.com',
    '415185564@qq.com',
    '1054436594@qq.com',
    'kyling25@163.com',
    '674238531@qq.com',
    'zhangla@gzucm.edu.cn',
    'dmzhang@jlu.edu.cn',
    '549404562@qq.com',
    '936052553@qq.com',
    '76979081@qq.com',
    '245831619@qq.com',
    'ywxgj@163.com',
    '704761720@qq.com',
    '234598285@qq.com',
    '740019224@qq.com',
    '673955230@qq.com',
    'ykrmctx@163.com',
    'lcm0315@163.com',
    'wenly9911@163.com',
    'guodonghua518@163.com',
    'liuge0629@sina.com',
    '13874309616@139.com',
    'ruqitantan@163.com',
    'huazhiyuan0614@163.com',
    '936090922@qq.com',
    'lin.linyx@163.com',
    'hong1985yan@vip.163.com',
    'sunliangzxz@126.com',
    '25079431@qq.com',
    '2629022956@qq.com',
    '442492822@qq.com',
    'xiejg537@126.com',
    'antioncogenes@163.com',
    '3565939485@qq.com',
    '20252025@163.com',
    'hanxiaolixiang@163.com',
    '15181982015@163.com',
    'ctfei@126.com',
    '38992417@qq.com',
    '444693792@qq.com',
    '278562662@qq.com',
    '18705606690@163.com',
    '1310280978@qq.com',
    'rettytty@qq.com',
    '1046152300@qq.com',
    '351559290@qq.com',
    '15200016649@163.com',
    '835810632@qq.com',
    '410307602@qq.com',
    '1803039737@qq.com',
    'lrongzhi2012@163.com',
    '399041341@qq.com',
    '1358115879@qq.com',
    '519008349@qq.com',
    '2934749827@qq.com',
    '13728368057@163.com',
    'houxiangyv123@163.com',
    'dl_wangxin1112@163.com',
    'bamboojh@163.com',
    '30372821@qq.com',
    'miaoshijie21@163.com',
    'anxiaofei2000@163.com',
    '854473117@qq.com',
    '171182092@qq.com',
    '779212051@qq.com',
    'Xxc619700@163.com',
    'wangdaodao971025@163.com',
    'huyulin_430@163.com',
    'dahe-016@163.com',
    '354570217@qq.com',
    '287795146@qq.com',
    'jinshanyingzi@126.com',
    '285687995@qq.com',
    '526147477@qq.com',
    'xrc224@126.com',
    '243413235@qq.com',
    'lqfeng02@163.com',
    '931245864@qq.com',
    '1811521920@qq.com',
    '392232021@qq.com',
    'tiantang4u@163.com',
    '49144691@qq.com',
    '767884648@qq.com',
    'xingxing.525@163.com',
    'shenzang123@126.com',
    'lizhong20007980@126.com',
    '39907295@qq.com',
    '1643158535@qq.com',
    'slyyhwhk@163.com',
    'yschen2000@126.com',
    '453750904@qq.com',
    'dulltrout07@163.com',
    'dragondongxiang@163.com',
    '604680019@qq.com',
    'gaocilin@xsxrmyy5.wecom.work',
    'whbniu@163.com',
    '1785589470@qq.com',
    '1066129938@qq.com',
    'ruibaobring@aliyun.com',
    'xujunmei02@163.com',
    '3931052891@qq.com'
  ];
begin

  -- 查找肾小球病专科 ID
  select id into _glom_specialty_id
    from public.specialties where code = 'glom';
  if _glom_specialty_id is null then
    raise exception '未找到 glom 专科，请先运行 migration_20260325_add_glom_specialty.sql';
  end if;

  -- 查找肾小球病培训项目 ID
  select id into _glom_project_id
    from public.learning_projects where project_code = 'PROJ-GLOM-2026';
  if _glom_project_id is null then
    raise exception '未找到 PROJ-GLOM-2026 项目，请先运行 migration_20260325_add_glom_specialty.sql';
  end if;

  -- 查找视频版商品 ID（作为来源商品记录）
  select id into _glom_product_id
    from public.products where product_code = 'GLOM-REG-VIDEO-2026';

  foreach _email in array _emails loop
    -- 邮箱不区分大小写查找用户
    select id into _uid
      from auth.users
      where lower(email) = lower(_email)
      limit 1;

    if _uid is null then
      raise notice '⚠ 未找到账号: %', _email;
      _skipped := _skipped + 1;
      continue;
    end if;

    -- 1. 授予 project_access 权益（幂等：如已有 active 的则跳过）
    insert into public.user_entitlements (
      user_id, entitlement_type, source_product_id,
      specialty_id, project_id,
      start_at, end_at, status, grant_reason
    )
    select
      _uid, 'project_access', _glom_product_id,
      _glom_specialty_id, _glom_project_id,
      now(), null, 'active',
      'batch_grant_20260328_glom_paid_students'
    where not exists (
      select 1 from public.user_entitlements
      where user_id = _uid
        and entitlement_type = 'project_access'
        and project_id = _glom_project_id
        and status = 'active'
    );

    -- 2. 创建项目报名记录（幂等）
    insert into public.project_enrollments (
      user_id, project_id,
      enrollment_status, approval_status,
      approved_at, notes
    )
    select
      _uid, _glom_project_id,
      'confirmed', 'approved',
      now(), 'batch_grant_20260328'
    where not exists (
      select 1 from public.project_enrollments
      where user_id = _uid
        and project_id = _glom_project_id
    );

    _granted := _granted + 1;
  end loop;

  raise notice '========================================';
  raise notice '✅ 授权完成: 成功 % 人, 跳过 % 人（未找到账号）', _granted, _skipped;
  raise notice '========================================';
end $$;

set echo off
set feedback off
set heading on
set sqlformat json-formatted
set pagesize 0
set trimspool on
whenever sqlerror exit sql.sqlcode

spool &1/v-instance.json
select instance_name, host_name, version, startup_time, status, database_status, instance_role, active_state from v$instance;
spool off

spool &1/gv-instance.json
select inst_id, instance_name, host_name, version, startup_time, status, database_status, instance_role, active_state from gv$instance order by inst_id;
spool off

spool &1/v-pdbs.json
select con_id, name, open_mode, restricted, open_time from v$pdbs order by con_id;
spool off

exit

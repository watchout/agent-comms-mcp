#include <stdio.h>
#include <stddef.h>
#include <sys/proc_info.h>
int main(void){printf("%zu %zu %zu %zu\n",sizeof(struct proc_bsdinfo),offsetof(struct proc_bsdinfo,pbi_pid),offsetof(struct proc_bsdinfo,pbi_start_tvsec),offsetof(struct proc_bsdinfo,pbi_start_tvusec));}

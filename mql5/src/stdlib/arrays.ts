/**
 * The MQL5 standard library's dynamic array classes (Include/Arrays/*.mqh).
 * The scalar variants are generated from one template so they cannot drift.
 */

export const ARRAY_MQH = String.raw`
#include <Object.mqh>
class CArray : public CObject
  {
protected:
   int               m_step_resize;
   int               m_data_total;
   int               m_data_max;
   int               m_sort_mode;
public:
                     CArray(void) { m_step_resize=16; m_data_total=0; m_data_max=0; m_sort_mode=-1; }
   int               Step(void) const { return(m_step_resize); }
   bool              Step(const int step) { if(step>0) { m_step_resize=step; return(true); } return(false); }
   int               Total(void) const { return(m_data_total); }
   int               Available(void) const { return(m_data_max-m_data_total); }
   int               Max(void) const { return(m_data_max); }
   bool              IsSorted(const int mode=0) const { return(m_sort_mode==mode); }
   int               SortMode(void) const { return(m_sort_mode); }
   void              Clear(void) { m_data_total=0; }
  };
`;

function scalarArray(className: string, type: string, invalid: string): string {
  return String.raw`
#include <Arrays\Array.mqh>
class ${className} : public CArray
  {
protected:
   ${type}           m_data[];
public:
                     ${className}(void) {}
   bool              Reserve(const int size)
     {
      if(size<=0) return(false);
      if(m_data_max<m_data_total+size)
         m_data_max=ArrayResize(m_data,m_data_total+size+m_step_resize);
      return(m_data_max>=m_data_total+size);
     }
   bool              Resize(const int size)
     {
      if(size<0) return(false);
      m_data_max=ArrayResize(m_data,size);
      if(m_data_total>size) m_data_total=size;
      return(true);
     }
   bool              Shutdown(void) { ArrayFree(m_data); m_data_total=0; m_data_max=0; return(true); }
   bool              Add(const ${type} element)
     {
      if(!Reserve(1)) return(false);
      m_data[m_data_total]=element;
      m_data_total++;
      m_sort_mode=-1;
      return(true);
     }
   bool              AddArray(const ${type} &src[])
     {
      int num=ArraySize(src);
      if(num==0) return(true);
      if(!Reserve(num)) return(false);
      for(int i=0; i<num; i++) { m_data[m_data_total]=src[i]; m_data_total++; }
      m_sort_mode=-1;
      return(true);
     }
   bool              Insert(const ${type} element,const int pos)
     {
      if(pos<0 || pos>m_data_total || !Reserve(1)) return(false);
      for(int i=m_data_total; i>pos; i--) m_data[i]=m_data[i-1];
      m_data[pos]=element;
      m_data_total++;
      m_sort_mode=-1;
      return(true);
     }
   bool              Update(const int index,const ${type} element)
     {
      if(index<0 || index>=m_data_total) return(false);
      m_data[index]=element;
      m_sort_mode=-1;
      return(true);
     }
   bool              Delete(const int index)
     {
      if(index<0 || index>=m_data_total) return(false);
      for(int i=index; i<m_data_total-1; i++) m_data[i]=m_data[i+1];
      m_data_total--;
      return(true);
     }
   bool              DeleteRange(int from,int to)
     {
      if(from<0 || to<0 || from>to || from>=m_data_total) return(false);
      if(to>=m_data_total) to=m_data_total-1;
      int count=to-from+1;
      for(int i=from; i<m_data_total-count; i++) m_data[i]=m_data[i+count];
      m_data_total-=count;
      return(true);
     }
   ${type}           At(const int index) const
     {
      if(index<0 || index>=m_data_total) return(${invalid});
      return(m_data[index]);
     }
   int               Search(const ${type} element) const
     {
      for(int i=0; i<m_data_total; i++) if(m_data[i]==element) return(i);
      return(-1);
     }
   int               SearchLinear(const ${type} element) const { return(Search(element)); }
   void              Sort(const int mode=0)
     {
      if(m_data_total<=1) { m_sort_mode=mode; return; }
      ArrayResize(m_data,m_data_total);
      m_data_max=m_data_total;
      ArraySort(m_data);
      m_sort_mode=mode;
     }
   bool              AssignArray(const ${type} &src[]) { m_data_total=0; return(AddArray(src)); }
  };
`;
}

export const ARRAY_DOUBLE_MQH = scalarArray('CArrayDouble', 'double', 'DBL_MAX');
export const ARRAY_INT_MQH = scalarArray('CArrayInt', 'int', 'INT_MAX');
export const ARRAY_LONG_MQH = scalarArray('CArrayLong', 'long', 'LONG_MAX');
export const ARRAY_STRING_MQH = scalarArray('CArrayString', 'string', '""');

export const ARRAY_OBJ_MQH = String.raw`
#include <Arrays\Array.mqh>
class CArrayObj : public CArray
  {
protected:
   CObject          *m_data[];
   bool              m_free_mode;
public:
                     CArrayObj(void) { m_free_mode=true; }
   bool              FreeMode(void) const { return(m_free_mode); }
   void              FreeMode(const bool mode) { m_free_mode=mode; }
   bool              Reserve(const int size)
     {
      if(size<=0) return(false);
      if(m_data_max<m_data_total+size)
         m_data_max=ArrayResize(m_data,m_data_total+size+m_step_resize);
      return(m_data_max>=m_data_total+size);
     }
   bool              Add(CObject *element)
     {
      if(CheckPointer(element)==POINTER_INVALID || !Reserve(1)) return(false);
      m_data[m_data_total]=element;
      m_data_total++;
      m_sort_mode=-1;
      return(true);
     }
   bool              Insert(CObject *element,const int pos)
     {
      if(pos<0 || pos>m_data_total || CheckPointer(element)==POINTER_INVALID || !Reserve(1)) return(false);
      for(int i=m_data_total; i>pos; i--) m_data[i]=m_data[i-1];
      m_data[pos]=element;
      m_data_total++;
      m_sort_mode=-1;
      return(true);
     }
   bool              Update(const int index,CObject *element)
     {
      if(index<0 || index>=m_data_total) return(false);
      if(m_free_mode && CheckPointer(m_data[index])==POINTER_DYNAMIC) delete m_data[index];
      m_data[index]=element;
      m_sort_mode=-1;
      return(true);
     }
   CObject          *Detach(const int index)
     {
      if(index<0 || index>=m_data_total) return(NULL);
      CObject *result=m_data[index];
      for(int i=index; i<m_data_total-1; i++) m_data[i]=m_data[i+1];
      m_data_total--;
      return(result);
     }
   bool              Delete(const int index)
     {
      if(index<0 || index>=m_data_total) return(false);
      if(m_free_mode && CheckPointer(m_data[index])==POINTER_DYNAMIC) delete m_data[index];
      for(int i=index; i<m_data_total-1; i++) m_data[i]=m_data[i+1];
      m_data_total--;
      return(true);
     }
   CObject          *At(const int index) const
     {
      if(index<0 || index>=m_data_total) return(NULL);
      return(m_data[index]);
     }
   void              Clear(void)
     {
      if(m_free_mode)
         for(int i=0; i<m_data_total; i++)
            if(CheckPointer(m_data[i])==POINTER_DYNAMIC) delete m_data[i];
      m_data_total=0;
     }
   bool              Shutdown(void) { Clear(); ArrayFree(m_data); m_data_max=0; return(true); }
   int               Search(const CObject *element) const
     {
      for(int i=0; i<m_data_total; i++) if(m_data[i].Compare(element,m_sort_mode)==0) return(i);
      return(-1);
     }
   void              Sort(const int mode=0)
     {
      // Insertion sort through the elements' own Compare, as the library does.
      for(int i=1; i<m_data_total; i++)
        {
         CObject *key=m_data[i];
         int j=i-1;
         while(j>=0 && m_data[j].Compare(key,mode)>0) { m_data[j+1]=m_data[j]; j--; }
         m_data[j+1]=key;
        }
      m_sort_mode=mode;
     }
  };
`;
